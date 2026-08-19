import { EventEmitter } from 'node:events'
import type {
  ConfigUpdateResult,
  EnvBlock,
  ServiceDescriptor,
  ServiceInstance,
  ServiceInstanceDescriptor,
  ServiceInstanceRef,
  ServiceOwnerId,
  ServiceStatus
} from '../../shared/service.js'
import { MACHINE_OWNER, instanceKey } from '../../shared/service.js'
import type { JSONSchema } from '../../shared/json-schema.js'
import type { ConfigStore } from '../core/config-store.js'
import type { LogAggregator } from '../core/log-aggregator.js'
import type { ProcessManager } from '../core/process-manager.js'
import type { PortAllocator } from '../core/port-allocator.js'
import { portHolder } from '../core/port-holder.js'
import type { DockerBackend, DockerStack } from '../backends/docker-backend.js'
import { DockerServiceDriver } from './docker-service.js'
import {
  ServiceCatalogue,
  defaultsFor,
  interpolate,
  portFields,
  validate
} from './registry.js'

/** How long a health result is reused before another probe is worth doing. */
const STATUS_TTL_MS = 3000

interface CachedStatus {
  status: ServiceStatus
  at: number
}

/** Resolves an owner id to the compose project its stack lives in. */
export type ComposeProjectResolver = (owner: ServiceOwnerId) => string

/** Resolves an owner id to a human name, for defaults and labels. */
export type OwnerNameResolver = (owner: ServiceOwnerId) => string

/**
 * Every service instance: which exist, who owns them, and what each is doing.
 *
 * The unit of everything here is `(owner, serviceId)` rather than `serviceId`.
 * That is the whole change: two projects can each attach MySQL, get their own
 * port, their own credentials, their own binlog settings and their own data,
 * and neither can see the other's.
 */
export class ServiceInstances extends EventEmitter {
  private readonly statuses = new Map<string, CachedStatus>()
  private healthTimer: NodeJS.Timeout | null = null

  constructor(
    private readonly catalogue: ServiceCatalogue,
    private readonly store: ConfigStore,
    private readonly logs: LogAggregator,
    private readonly processes: ProcessManager,
    private readonly ports: PortAllocator,
    private readonly docker: DockerBackend,
    private readonly composeProjectFor: ComposeProjectResolver,
    private readonly ownerNameFor: OwnerNameResolver
  ) {
    super()
    // The backend renders each owner's compose file from live instance state
    // rather than from a cache it accumulates, so it needs a way back in here.
    this.docker.setStackResolver((owner) => this.stack(owner))
  }

  // ---------------------------------------------------------------- lookup

  all(): ServiceInstance[] {
    return Object.values(this.store.get().serviceInstances)
  }

  forOwner(owner: ServiceOwnerId): ServiceInstance[] {
    return this.all().filter((i) => i.owner === owner)
  }

  get(ref: ServiceInstanceRef): ServiceInstance | null {
    return this.store.get().serviceInstances[instanceKey(ref)] ?? null
  }

  private require(ref: ServiceInstanceRef): ServiceInstance {
    const instance = this.get(ref)
    if (!instance) throw new Error(`No ${ref.serviceId} instance for ${ref.owner}`)
    return instance
  }

  // ---------------------------------------------------------- attach/detach

  /**
   * Give an owner its own instance of a service.
   *
   * Ports are allocated HERE and nowhere else. Allocating at start time looks
   * equivalent but is not: the allocator drops a stored assignment when the
   * port is not free, and a running instance is exactly what makes its own port
   * not free — so a restart would silently move a live database and invalidate
   * every `.env` pointing at it. Start reads the allocation; it never makes one.
   */
  async attach(ref: ServiceInstanceRef, options: { autoStart?: boolean } = {}): Promise<ServiceInstanceDescriptor> {
    const existing = this.get(ref)
    if (existing) return this.describeInstance(ref)

    const driver = this.catalogue.get(ref.serviceId)
    const schema = driver.configSchema
    // Every instance starts from its driver's defaults, resolved for its own
    // project. Nothing is carried over from another instance or from the
    // pre-per-project config in `serviceDefaults`.
    //
    // Seeding from previous config was tried and removed. Some of it is
    // per-instance by nature — a port, a database named after the project — and
    // filtering those still let the rest through: a project attaching MySQL
    // inherited another one's binary-log settings and extra server arguments,
    // silently, with the form showing them as though they were defaults. Config
    // that appears from nowhere is worse than config you have to set twice.
    // `serviceDefaults` is retained only so migrated v1 config is not deleted.
    const values = this.resolveDefaults(ref, defaultsFor(schema), schema)

    for (const field of portFields(schema)) {
      const preferred = Number(values[field] ?? schema.properties?.[field]?.default ?? 0)
      values[field] = await this.ports.allocate(this.portKey(ref, field), {
        preferred: preferred || undefined,
        near: true
      })
    }

    const instance: ServiceInstance = {
      owner: ref.owner,
      serviceId: ref.serviceId,
      version: this.store.get().serviceVersions[ref.serviceId] ?? 'latest',
      values,
      autoStart: options.autoStart ?? true,
      createdAt: Date.now()
    }
    this.store.update((s) => {
      s.serviceInstances[instanceKey(ref)] = instance
    })
    this.logs.attach(instanceKey(ref), driver.logSources(ref))
    return this.emitChanged(ref)
  }

  /**
   * Stop an instance and forget it. Data is deliberately left behind: the
   * volume outlives the instance, so re-attaching the same service to the same
   * project finds its database intact. Destroying it is a separate, explicit
   * action — see `ProjectManager.forget`.
   */
  async detach(ref: ServiceInstanceRef): Promise<void> {
    const instance = this.get(ref)
    if (!instance) return
    await this.stop(ref).catch(() => undefined)
    this.logs.detach(instanceKey(ref))
    this.ports.releasePrefix(this.portKey(ref, ''))
    this.statuses.delete(instanceKey(ref))
    this.store.update((s) => {
      delete s.serviceInstances[instanceKey(ref)]
    })
    this.emit('detached', instanceKey(ref))
  }

  private portKey(ref: ServiceInstanceRef, field: string): string {
    return `service:${ref.owner}:${ref.serviceId}:${field}`
  }

  /**
   * Drop instances whose owner no longer exists.
   *
   * `forget()` detaches a project's instances, so in the ordinary case there is
   * nothing here to do. It is the disordinary case this exists for: a crash
   * between removing the project and detaching its stack leaves records that
   * nothing will ever start, stop or clean up again — an orphaned instance
   * holds a port assignment forever and points at containers no code path can
   * reach. Cheap to check on launch, and the alternative is a leak that only
   * ever grows.
   */
  async reconcile(knownOwners: Iterable<ServiceOwnerId>): Promise<ServiceInstanceRef[]> {
    const known = new Set<ServiceOwnerId>(knownOwners)
    known.add(MACHINE_OWNER)
    const orphans = this.all()
      .filter((i) => !known.has(i.owner))
      .map((i) => ({ owner: i.owner, serviceId: i.serviceId }))

    for (const ref of orphans) {
      await this.detach(ref).catch(() => undefined)
    }

    // Re-register every surviving instance's ports.
    //
    // The allocator and the instances are two records of the same fact, and
    // they can drift: an assignment lost for any reason leaves a live instance
    // holding a port the allocator believes is free, so the next project to
    // attach the same service is handed the same number and collides on start.
    // The instance is the authority — it is what the container is actually
    // published on — so the allocation is restored from it, never the reverse.
    this.store.update((s) => {
      for (const instance of Object.values(s.serviceInstances)) {
        const ref = { owner: instance.owner, serviceId: instance.serviceId }
        const driver = this.catalogue.has(instance.serviceId)
          ? this.catalogue.get(instance.serviceId)
          : null
        if (!driver) continue
        for (const field of portFields(driver.configSchema)) {
          const port = Number(instance.values[field])
          if (port) s.ports[this.portKey(ref, field)] = port
        }
      }
    })

    return orphans
  }

  /**
   * Resolve `${project}` in a schema default against the owner.
   *
   * Per-project stacks already keep instances apart, so this is not what makes
   * them safe — it is what makes them legible. Every project's database being
   * called `harbor` means a psql prompt, a dump file or a connection string in
   * a log tells you nothing about which project it belongs to, and two shells
   * open side by side look identical. Naming them after the project fixes that
   * for free, and a driver opts in by writing `${project}` as its default
   * rather than by any code here knowing which fields are names.
   */
  private resolveDefaults(
    ref: ServiceInstanceRef,
    values: Record<string, unknown>,
    schema: JSONSchema
  ): Record<string, unknown> {
    const name = this.ownerNameFor(ref.owner)
    // Conservative slug: valid as a database name, a username and a Docker
    // identifier all at once, which the raw project name is not.
    const slug = name.toLowerCase().replace(/[^a-z0-9_]+/g, '_').replace(/^_+|_+$/g, '')
    const scope = { project: slug || 'harbor', projectName: name }

    const out: Record<string, unknown> = {}
    for (const [key, value] of Object.entries(values)) {
      const template = schema.properties?.[key]?.default
      const derived = typeof template === 'string' && template.includes('${')
      if (!derived || typeof value !== 'string') {
        out[key] = value
        continue
      }
      out[key] = this.uniqueFor(ref, key, interpolate(value, scope))
    }
    return out
  }

  /**
   * Make an owner-derived suggestion unique across instances of this service.
   *
   * Two parked directories can both be called `api`, and then both projects
   * would be offered `api` as their database name. They would not collide —
   * each has its own server — but two identically named databases on two ports
   * is exactly the ambiguity naming them after the project was meant to remove.
   * A suggestion that could be mistaken for another project's is not worth
   * making, so it is disambiguated the same way the compose namespace is.
   */
  private uniqueFor(ref: ServiceInstanceRef, field: string, wanted: string): string {
    const self = instanceKey(ref)
    const taken = new Set(
      Object.entries(this.store.get().serviceInstances)
        .filter(([key, i]) => key !== self && i.serviceId === ref.serviceId)
        .map(([, i]) => String(i.values[field] ?? ''))
    )
    if (!taken.has(wanted)) return wanted
    for (let n = 2; ; n++) {
      const candidate = `${wanted}_${n}`
      if (!taken.has(candidate)) return candidate
    }
  }

  // ------------------------------------------------------------- lifecycle

  async start(ref: ServiceInstanceRef): Promise<ServiceInstanceDescriptor> {
    const instance = this.require(ref)
    const driver = this.catalogue.get(ref.serviceId)

    // Refuse to start onto a port something else already holds. Docker binds
    // 0.0.0.0 while a local process may hold 127.0.0.1, and the more specific
    // bind wins — so the container starts, looks fine, and every request
    // (including Harbor's own health check) reaches the other process instead.
    const current = await this.statusOf(ref, true)
    if (current.health !== 'running') {
      const wanted = driver.configuredPorts?.(instance) ?? driver.defaultPorts
      const conflicts: string[] = []
      for (const port of wanted) {
        const holder = await portHolder(port)
        if (holder) conflicts.push(`:${port} is held by ${holder}`)
      }
      if (conflicts.length) {
        throw new Error(
          `Cannot start ${driver.displayName} for ${ref.owner} — ${conflicts.join(', ')}. ` +
            `Stop it, or change the port in this service's settings.`
        )
      }
    }

    await driver.start(instance)
    this.logs.attach(instanceKey(ref), driver.logSources(ref))

    // Not awaited: bootstrapping waits for the server to accept connections,
    // which on a first run is behind an image pull and a data-directory
    // initialisation. Blocking the start call on that would leave the UI
    // spinning for a minute with nothing to show for it. The outcome goes to
    // the log either way — a silent failure here surfaces much later as the
    // application being unable to connect, which is the hardest possible place
    // to diagnose it from.
    if (driver.bootstrap) {
      void driver
        .bootstrap(instance)
        .then(() => this.logs.push(instanceKey(ref), 'harbor', 'configuration applied'))
        .catch((err: Error) =>
          this.logs.push(instanceKey(ref), 'harbor', `configuration failed: ${err.message}`)
        )
    }

    return this.emitChanged(ref)
  }

  async stop(ref: ServiceInstanceRef): Promise<ServiceInstanceDescriptor> {
    await this.catalogue.get(ref.serviceId).stop(this.require(ref))
    return this.emitChanged(ref)
  }

  /** Start every instance an owner has marked auto-start. */
  async startOwner(owner: ServiceOwnerId): Promise<void> {
    for (const instance of this.forOwner(owner)) {
      if (!instance.autoStart) continue
      await this.start({ owner, serviceId: instance.serviceId }).catch(() => undefined)
    }
  }

  /**
   * Stop an owner's whole stack. Instances start and stop with their project
   * because memory is the real constraint: one idle MySQL is ~500 MiB against a
   * ~4 GiB Docker VM, so leaving every project's stack up is three or four
   * projects before the machine is out.
   */
  async stopOwner(owner: ServiceOwnerId): Promise<void> {
    for (const instance of this.forOwner(owner)) {
      await this.stop({ owner, serviceId: instance.serviceId }).catch(() => undefined)
    }
  }

  async stopAll(): Promise<void> {
    for (const instance of this.all()) {
      await this.stop({ owner: instance.owner, serviceId: instance.serviceId }).catch(
        () => undefined
      )
    }
  }

  async install(serviceId: string, version: string): Promise<void> {
    await this.catalogue.get(serviceId).install(version)
    this.store.update((s) => {
      s.serviceVersions[serviceId] = version
    })
  }

  // ------------------------------------------------------------------ config

  /**
   * Validate against the driver's own configSchema before persisting. The
   * schema already drives the form; using it as the validator too means a
   * driver cannot end up with rules the UI doesn't know about, and no service
   * needs hand-written validation.
   */
  async updateConfig(
    ref: ServiceInstanceRef,
    patch: Partial<ServiceInstance>
  ): Promise<ConfigUpdateResult> {
    const current = this.require(ref)
    const schema = this.catalogue.get(ref.serviceId).configSchema

    // An empty values patch means "reset to defaults" — the form's Reset button.
    const reset = patch.values && Object.keys(patch.values).length === 0
    const values = reset
      ? {
          ...this.resolveDefaults(ref, defaultsFor(schema), schema),
          ...this.allocatedPorts(ref, schema)
        }
      : { ...current.values, ...(patch.values ?? {}) }

    const errors = validate(schema, values)
    if (errors.length) return { ok: false, errors }

    const next: ServiceInstance = {
      ...current,
      ...patch,
      values,
      owner: ref.owner,
      serviceId: ref.serviceId
    }
    // Saving does NOT update `serviceDefaults`. Carrying a tuned config forward
    // sounded helpful and was the opposite: the second project to attach MySQL
    // silently inherited the first one's binlog settings and credentials, which
    // is precisely the cross-project bleed per-project stacks exist to end. Each
    // instance starts from its driver's defaults, resolved for its own project.
    this.store.update((s) => {
      s.serviceInstances[instanceKey(ref)] = next
    })

    return { ok: true, instance: await this.emitChanged(ref) }
  }

  /** Ports already assigned to this instance, so a reset does not move them. */
  private allocatedPorts(ref: ServiceInstanceRef, schema: JSONSchema): Record<string, unknown> {
    const out: Record<string, unknown> = {}
    for (const field of portFields(schema)) {
      const port = this.ports.peek(this.portKey(ref, field))
      if (port) out[field] = port
    }
    return out
  }

  // ------------------------------------------------------------------ health

  /**
   * Health checks hit the network, and the services list runs on every UI
   * mount, so an uncached describe cost one probe per instance per render.
   * Results are reused briefly and refreshed by the background poller instead.
   */
  private async statusOf(ref: ServiceInstanceRef, fresh = false): Promise<ServiceStatus> {
    const key = instanceKey(ref)
    const cached = this.statuses.get(key)
    if (!fresh && cached && Date.now() - cached.at < STATUS_TTL_MS) return cached.status

    const instance = this.get(ref)
    if (!instance) return { health: 'stopped', ports: [] }

    const status = await this.catalogue
      .get(ref.serviceId)
      .healthCheck(instance)
      .catch((err: Error): ServiceStatus => ({ health: 'error', ports: [], error: err.message }))

    // A driver that only probes an endpoint reports a crashed service as merely
    // unreachable. Overlaying the process state here means every driver gets
    // truthful crash reporting without implementing it.
    const handle = this.processes.findByOwner('service', key, true)
    const resolved: ServiceStatus =
      handle?.state === 'crashed' && status.health !== 'running'
        ? {
            health: 'error',
            ports: [],
            error: `process exited unexpectedly${
              handle.exitCode === null ? '' : ` (code ${handle.exitCode})`
            }`
          }
        : status

    this.statuses.set(key, { status: resolved, at: Date.now() })
    return resolved
  }

  /**
   * Poll instances so the UI shows one that died on its own, and emit only on
   * an actual transition — re-pushing an unchanged descriptor every few seconds
   * would be pure IPC noise.
   */
  startHealthPolling(intervalMs = 5000): void {
    if (this.healthTimer) return
    this.healthTimer = setInterval(() => {
      void (async () => {
        for (const instance of this.all()) {
          const ref = { owner: instance.owner, serviceId: instance.serviceId }
          const before = this.statuses.get(instanceKey(ref))?.status
          const after = await this.statusOf(ref, true)
          if (!before || before.health !== after.health || !samePorts(before, after)) {
            this.emit('changed', await this.describeInstance(ref))
          }
        }
      })()
    }, intervalMs)
  }

  stopHealthPolling(): void {
    if (this.healthTimer) clearInterval(this.healthTimer)
    this.healthTimer = null
  }

  // ------------------------------------------------------------- describing

  async describeInstance(
    ref: ServiceInstanceRef,
    options: { fresh?: boolean } = {}
  ): Promise<ServiceInstanceDescriptor> {
    const instance = this.require(ref)
    const driver = this.catalogue.get(ref.serviceId)
    const installedVersions = await driver.installedVersions().catch(() => [])
    return {
      ...instance,
      key: instanceKey(ref),
      displayName: driver.displayName,
      description: driver.description,
      backend: driver.backend,
      icon: driver.icon,
      tint: driver.tint,
      configSchema: driver.configSchema,
      envKeys: Object.keys(driver.envHints),
      installed: installedVersions.length > 0,
      installedVersions,
      status: await this.statusOf(ref, options.fresh),
      console: driver.console?.(instance) ?? null,
      composeProject: driver.backend === 'docker' ? this.composeProjectFor(ref.owner) : null
    }
  }


  /** The catalogue, each entry carrying every instance of it. */
  async describeCatalogue(): Promise<ServiceDescriptor[]> {
    return Promise.all(
      this.catalogue.all().map(async (driver) => {
        const installedVersions = await driver.installedVersions().catch(() => [])
        const instances = await Promise.all(
          this.all()
            .filter((i) => i.serviceId === driver.id)
            .map((i) => this.describeInstance({ owner: i.owner, serviceId: driver.id }))
        )
        return {
          id: driver.id,
          displayName: driver.displayName,
          description: driver.description,
          backend: driver.backend,
          defaultPorts: driver.defaultPorts,
          icon: driver.icon,
          tint: driver.tint,
          configSchema: driver.configSchema,
          envKeys: Object.keys(driver.envHints),
          installed: installedVersions.length > 0,
          installedVersions,
          instances
        } satisfies ServiceDescriptor
      })
    )
  }

  // --------------------------------------------------------------- env export

  /**
   * Renders an instance's envHints against its LIVE config — the actual bound
   * port and resolved credentials, not schema defaults. This is the whole
   * env-export feature; there is no per-service export code anywhere.
   */
  async envBlock(ref: ServiceInstanceRef): Promise<EnvBlock> {
    const driver = this.catalogue.get(ref.serviceId)
    const instance = this.require(ref)
    const status = await this.statusOf(ref).catch(() => null)
    const scope: Record<string, unknown> = {
      ...instance.values,
      version: instance.version,
      host: '127.0.0.1',
      port: status?.ports[0] ?? instance.values.port ?? driver.defaultPorts[0]
    }
    return {
      serviceId: ref.serviceId,
      owner: ref.owner,
      key: instanceKey(ref),
      displayName: driver.displayName,
      vars: Object.entries(driver.envHints).map(([key, template]) => ({
        key,
        value: interpolate(template, scope)
      }))
    }
  }

  async envBlocks(refs: ServiceInstanceRef[]): Promise<EnvBlock[]> {
    return Promise.all(refs.map((ref) => this.envBlock(ref)))
  }

  // ------------------------------------------------------------------ compose

  /**
   * One owner's whole Docker stack, rendered from persisted state. This is what
   * the backend writes to disk before every compose command, so the file is
   * always a complete picture rather than an accumulation.
   */
  stack(owner: ServiceOwnerId): DockerStack {
    const fragments: DockerStack['fragments'] = {}
    for (const instance of this.forOwner(owner)) {
      const driver = this.catalogue.has(instance.serviceId)
        ? this.catalogue.get(instance.serviceId)
        : null
      if (driver instanceof DockerServiceDriver) {
        fragments[instance.serviceId] = driver.buildFragment(instance)
      }
    }
    return { composeProject: this.composeProjectFor(owner), fragments }
  }

  private async emitChanged(ref: ServiceInstanceRef): Promise<ServiceInstanceDescriptor> {
    // A start/stop just changed reality; never report the cached value.
    const descriptor = await this.describeInstance(ref, { fresh: true })
    this.emit('changed', descriptor)
    return descriptor
  }
}

function samePorts(a: ServiceStatus, b: ServiceStatus): boolean {
  return a.ports.length === b.ports.length && a.ports.every((p, i) => p === b.ports[i])
}


export { MACHINE_OWNER }

import { EventEmitter } from 'node:events'
import Ajv, { type ErrorObject } from 'ajv'
import type {
  ConfigUpdateResult,
  EnvBlock,
  FieldError,
  ServiceConfig,
  ServiceDescriptor,
  ServiceDriver,
  ServiceStatus
} from '../../shared/service.js'
import type { JSONSchema } from '../../shared/json-schema.js'
import type { ConfigStore } from '../core/config-store.js'
import type { LogAggregator } from '../core/log-aggregator.js'
import type { ProcessManager } from '../core/process-manager.js'

/**
 * Holds every ServiceDriver and is the only thing the IPC layer talks to.
 * Adding a service means registering a driver here — there is deliberately no
 * hook for per-service behaviour anywhere above this line.
 */
/** How long a health result is reused before another probe is worth doing. */
const STATUS_TTL_MS = 3000

interface CachedStatus {
  status: ServiceStatus
  at: number
}

export class ServiceRegistry extends EventEmitter {
  private readonly drivers = new Map<string, ServiceDriver>()
  private readonly statuses = new Map<string, CachedStatus>()
  private healthTimer: NodeJS.Timeout | null = null

  constructor(
    private readonly store: ConfigStore,
    private readonly logs: LogAggregator,
    private readonly processes: ProcessManager
  ) {
    super()
  }

  register(driver: ServiceDriver): void {
    this.drivers.set(driver.id, driver)
    // Seed config from the schema defaults on first sight of a driver.
    if (!this.store.get().services[driver.id]) {
      this.store.update((s) => {
        s.services[driver.id] = {
          serviceId: driver.id,
          version: 'latest',
          values: defaultsFor(driver.configSchema),
          autoStart: false
        }
      })
    }
    this.logs.attach(driver.id, driver.logSources)
  }

  get(id: string): ServiceDriver {
    const driver = this.drivers.get(id)
    if (!driver) throw new Error(`Unknown service: ${id}`)
    return driver
  }

  configFor(id: string): ServiceConfig {
    const stored = this.store.get().services[id]
    if (stored) return stored
    const driver = this.get(id)
    return {
      serviceId: id,
      version: 'latest',
      values: defaultsFor(driver.configSchema),
      autoStart: false
    }
  }

  async describeAll(): Promise<ServiceDescriptor[]> {
    return Promise.all([...this.drivers.keys()].map((id) => this.describe(id)))
  }

  async describe(id: string, options: { fresh?: boolean } = {}): Promise<ServiceDescriptor> {
    const driver = this.get(id)
    const config = this.configFor(id)
    const installedVersions = await driver.installedVersions().catch(() => [])
    const status = await this.statusOf(id, options.fresh)
    return {
      id: driver.id,
      displayName: driver.displayName,
      description: driver.description,
      backend: driver.backend,
      defaultPorts: driver.defaultPorts,
      configSchema: driver.configSchema,
      envKeys: Object.keys(driver.envHints),
      installed: installedVersions.length > 0,
      installedVersions,
      config,
      status
    }
  }

  /**
   * Health checks hit the network (MinIO polls an HTTP endpoint), and
   * `services:list` runs on every UI mount, so an uncached describe cost one
   * probe per service per render. Results are reused briefly and refreshed by
   * the background poller instead.
   */
  private async statusOf(id: string, fresh = false): Promise<ServiceStatus> {
    const cached = this.statuses.get(id)
    if (!fresh && cached && Date.now() - cached.at < STATUS_TTL_MS) return cached.status

    const status = await this.get(id)
      .healthCheck()
      .catch((err: Error): ServiceStatus => ({ health: 'error', ports: [], error: err.message }))

    // A driver that only probes an endpoint reports a crashed service as merely
    // unreachable. Overlaying the process state here means every driver gets
    // truthful crash reporting without implementing it.
    const handle = this.processes.findByOwner('service', id, true)
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

    this.statuses.set(id, { status: resolved, at: Date.now() })
    return resolved
  }

  /**
   * Poll installed services so the UI shows a service that died on its own,
   * and emit only on an actual transition — re-pushing an unchanged descriptor
   * every few seconds would be pure IPC noise.
   */
  startHealthPolling(intervalMs = 5000): void {
    if (this.healthTimer) return
    this.healthTimer = setInterval(() => {
      void (async () => {
        for (const id of this.drivers.keys()) {
          const before = this.statuses.get(id)?.status
          const after = await this.statusOf(id, true)
          if (!before || before.health !== after.health || !samePorts(before, after)) {
            this.emit('changed', await this.describe(id))
          }
        }
      })()
    }, intervalMs)
  }

  stopHealthPolling(): void {
    if (this.healthTimer) clearInterval(this.healthTimer)
    this.healthTimer = null
  }

  async install(id: string, version: string): Promise<void> {
    await this.get(id).install(version)
    this.store.update((s) => {
      const existing = s.services[id]
      if (existing) existing.version = version
    })
    this.emitChanged(id)
  }

  async start(id: string): Promise<ServiceDescriptor> {
    const driver = this.get(id)
    await driver.start(this.configFor(id))
    this.logs.attach(id, driver.logSources)
    return this.emitChanged(id)
  }

  async stop(id: string): Promise<ServiceDescriptor> {
    await this.get(id).stop()
    return this.emitChanged(id)
  }

  /**
   * Validate against the driver's own configSchema before persisting. The
   * schema already drives the form; using it as the validator too means a
   * driver cannot end up with rules the UI doesn't know about, and no service
   * needs hand-written validation.
   */
  async updateConfig(id: string, patch: Partial<ServiceConfig>): Promise<ConfigUpdateResult> {
    const driver = this.get(id)
    const current = this.configFor(id)

    // An empty values patch means "reset to defaults" — the form's Reset button.
    const values =
      patch.values && Object.keys(patch.values).length === 0
        ? defaultsFor(driver.configSchema)
        : { ...current.values, ...(patch.values ?? {}) }

    const errors = validate(driver.configSchema, values)
    if (errors.length) return { ok: false, errors }

    const next: ServiceConfig = { ...current, ...patch, values }
    this.store.update((s) => {
      s.services[id] = next
    })
    return { ok: true, service: await this.emitChanged(id) }
  }

  /**
   * Renders a service's envHints against its LIVE config — the actual bound
   * port and resolved credentials, not schema defaults. This is the whole
   * env-export feature; there is no per-service export code anywhere.
   */
  async envBlock(id: string): Promise<EnvBlock> {
    const driver = this.get(id)
    const config = this.configFor(id)
    const status = await this.statusOf(id).catch(() => null)
    const scope: Record<string, unknown> = {
      ...config.values,
      version: config.version,
      host: '127.0.0.1',
      port: status?.ports[0] ?? config.values.port ?? driver.defaultPorts[0]
    }
    return {
      serviceId: id,
      displayName: driver.displayName,
      vars: Object.entries(driver.envHints).map(([key, template]) => ({
        key,
        value: interpolate(template, scope)
      }))
    }
  }

  async envBlocks(ids: string[]): Promise<EnvBlock[]> {
    return Promise.all(ids.map((id) => this.envBlock(id)))
  }

  async autoStart(): Promise<void> {
    for (const id of this.drivers.keys()) {
      if (this.configFor(id).autoStart) {
        await this.start(id).catch(() => undefined)
      }
    }
  }

  async stopAll(): Promise<void> {
    for (const driver of this.drivers.values()) {
      await driver.stop().catch(() => undefined)
    }
  }

  private async emitChanged(id: string): Promise<ServiceDescriptor> {
    // A start/stop just changed reality; never report the cached value.
    const descriptor = await this.describe(id, { fresh: true })
    this.emit('changed', descriptor)
    return descriptor
  }
}

/** `${key}` interpolation against the live config scope. */
function samePorts(a: ServiceStatus, b: ServiceStatus): boolean {
  return a.ports.length === b.ports.length && a.ports.every((p, i) => p === b.ports[i])
}

export function interpolate(template: string, scope: Record<string, unknown>): string {
  return template.replace(/\$\{(\w+)\}/g, (_m, key: string) => {
    const value = scope[key]
    return value === undefined || value === null ? '' : String(value)
  })
}

// One compiled instance: Ajv caches by schema object identity, and driver
// schemas are stable for the process lifetime.
const ajv = new Ajv({ allErrors: true, coerceTypes: true, useDefaults: false, strict: false })

/** Schema violations, addressed to the field that caused each one. */
export function validate(schema: JSONSchema, values: Record<string, unknown>): FieldError[] {
  const check = ajv.compile(schema as object)
  if (check(values)) return []
  return (check.errors ?? []).map(toFieldError)
}

function toFieldError(error: ErrorObject): FieldError {
  // "must have required property 'port'" carries the field in params, not path.
  if (error.keyword === 'required') {
    const field = String((error.params as { missingProperty?: string }).missingProperty ?? '')
    return { field, message: 'is required' }
  }
  return {
    field: error.instancePath.replace(/^\//, ''),
    message: error.message ?? 'is invalid'
  }
}

export function defaultsFor(schema: JSONSchema): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const [key, prop] of Object.entries(schema.properties ?? {})) {
    if (prop.default !== undefined) out[key] = prop.default
  }
  return out
}

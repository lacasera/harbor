import { connect } from 'node:net'
import { writeFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import type { JSONSchema } from '../../shared/json-schema.js'
import type { LogSource } from '../../shared/logs.js'
import type { ProcessHandle } from '../../shared/process.js'
import type {
  ServiceConsole,
  ServiceDriver,
  ServiceIconKind,
  ServiceInstance,
  ServiceInstanceRef,
  ServiceStatus
} from '../../shared/service.js'
import type { ComposeFragment, DockerBackend } from '../backends/docker-backend.js'

/**
 * Everything that differs between one Docker-backed service and another. The
 * lifecycle around it — pull-on-start, compose fragment merging, container
 * state, log streaming — is identical for all of them, so it lives once in
 * DockerServiceDriver rather than being copy-pasted per service.
 */
export interface DockerServiceSpec {
  id: string
  displayName: string
  description: string
  defaultPorts: number[]
  icon: ServiceIconKind
  tint: string
  /** Offered in the version dropdown; the first entry is the default. */
  versions: string[]
  configSchema: JSONSchema
  envHints: Record<string, string>
  /** Compose definition for one instance, given its live config. */
  fragment(instance: ServiceInstance, version: string): ComposeFragment
  /**
   * The image's own command, e.g. `['mysqld']`. Declaring it turns on the
   * per-instance "extra arguments" field: the arguments are appended to this,
   * and without knowing the base there is nothing safe to append to — setting
   * `command` to the extras alone would replace the server with them.
   */
  commandBase?: string[]
  /**
   * Where a per-instance config file is mounted, e.g.
   * `/etc/mysql/conf.d/harbor.cnf`. Declaring it turns on the "extra
   * configuration" field. Services that do not set it simply do not offer one.
   */
  configMount?: string
  /**
   * Optional HTTP path probed on the first configured port. Container state
   * alone only proves the process exists, not that the service is ready.
   */
  healthPath?: string
  /**
   * Probe the first port with a TCP connect instead. Databases speak their own
   * protocols, so an HTTP request proves nothing — but accepting a connection
   * does distinguish "booting" from "ready", which container state cannot.
   */
  healthTcp?: boolean
  /**
   * Which of `defaultPorts` the health probe targets. Defaults to the first,
   * which is not always right: Mailpit's first port is SMTP because that is
   * what projects connect to, but only its second port speaks HTTP.
   */
  healthPortIndex?: number
  /** Treated as healthy; some services return 503 while still usable locally. */
  healthAcceptStatuses?: number[]
  /**
   * A command, run inside the container, that proves the service can actually
   * be used.
   *
   * `healthTcp` cannot: Docker's port proxy binds the published port the moment
   * the container starts, so a TCP connect succeeds while the server inside is
   * still initialising. Harbor reported MySQL as "accepting connections" a full
   * second and a half before it would answer a query — and far longer than that
   * on a first run.
   */
  readyCheck?(instance: ServiceInstance): string[]
  /** The service's own web UI, if it has one. See `consoleAt`. */
  console?(instance: ServiceInstance): ServiceConsole | null
  /**
   * A command run inside the container once it is healthy, to reconcile the
   * server with settings its image only honours when initialising an empty
   * volume — creating the configured database, granting the configured user.
   *
   * Must be idempotent: it runs on every start, not just the first.
   */
  bootstrap?(instance: ServiceInstance): BootstrapStep | null
}

/** A reconciliation command, with what to feed its stdin. */
export interface BootstrapStep {
  /** Shown in the log so a failure names what was being attempted. */
  label: string
  command: string[]
  stdin?: string
}

/** Config keys the driver owns rather than the spec. */
export const EXTRA_ARGS = 'extraArgs'
export const EXTRA_ENV = 'extraEnv'
export const EXTRA_CONFIG = 'extraConfig'

export class DockerServiceDriver implements ServiceDriver {
  readonly backend = 'docker' as const

  /**
   * Instances confirmed usable since their container last started.
   *
   * A memo, not state the driver acts on — it holds no notion of "the" running
   * instance, which is what made drivers single-instance before. The readiness
   * command costs a `docker exec`, so it is asked once per container start and
   * the cheap check carries it from there; the entry is dropped as soon as the
   * container is not running, which a stop/start cycle always passes through.
   */
  private readonly confirmedReady = new Set<string>()

  constructor(
    private readonly docker: DockerBackend,
    private readonly spec: DockerServiceSpec
  ) {}

  get id(): string {
    return this.spec.id
  }
  get displayName(): string {
    return this.spec.displayName
  }
  get description(): string {
    return this.spec.description
  }
  get defaultPorts(): number[] {
    return this.spec.defaultPorts
  }
  get icon(): ServiceIconKind {
    return this.spec.icon
  }
  get tint(): string {
    return this.spec.tint
  }
  get envHints(): Record<string, string> {
    return this.spec.envHints
  }

  /**
   * The spec's schema plus the escape hatches every Docker service inherits.
   *
   * A schema field is the better answer whenever one exists — it gets a real
   * form control, validation and an `.env` reference for free — but no schema
   * will ever cover every server setting a project needs, and a user who cannot
   * express one has no route at all. These three cover the rest, uniformly, so
   * no service grows a bespoke "advanced" panel.
   */
  get configSchema(): JSONSchema {
    const properties: Record<string, JSONSchema> = { ...(this.spec.configSchema.properties ?? {}) }
    if (this.spec.commandBase) {
      properties[EXTRA_ARGS] = {
        type: 'string',
        title: 'Extra arguments',
        section: 'Advanced',
        description: `Appended to \`${this.spec.commandBase.join(' ')}\`, one per line`,
        format: 'textarea',
        default: ''
      }
    }
    properties[EXTRA_ENV] = {
      type: 'string',
      title: 'Extra environment',
      section: 'Advanced',
      description: 'KEY=value, one per line',
      format: 'textarea',
      default: ''
    }
    if (this.spec.configMount) {
      properties[EXTRA_CONFIG] = {
        type: 'string',
        title: 'Extra configuration',
        section: 'Advanced',
        description: `Mounted read-only at ${this.spec.configMount}`,
        format: 'textarea',
        default: ''
      }
    }
    return { ...this.spec.configSchema, properties }
  }

  console(instance: ServiceInstance): ServiceConsole | null {
    return this.spec.console?.(instance) ?? null
  }

  /** Per instance: two projects' containers must not share a log stream. */
  logSources(ref: ServiceInstanceRef): LogSource[] {
    return [{ kind: 'stdout', label: `${ref.owner}:${ref.serviceId}` }]
  }

  async availableVersions(): Promise<string[]> {
    return this.spec.versions
  }

  /**
   * Compose pulls on first start, so there is no separate install step. We
   * report the catalogue as installed rather than shelling out to `docker
   * images` on every describe.
   */
  async installedVersions(): Promise<string[]> {
    return this.spec.versions
  }

  async install(): Promise<void> {
    // No-op: `docker compose up -d` pulls the image on demand.
  }

  private versionFor(instance: ServiceInstance): string {
    const first = this.spec.versions[0] as string
    return instance.version === 'latest' || !this.spec.versions.includes(instance.version)
      ? first
      : instance.version
  }

  /**
   * The spec's fragment, plus everything that is true of every Docker service:
   * ownership labels, the user's extra arguments, environment and config file.
   *
   * Labels are what make a stray container attributable later. Without them a
   * container left behind by a crash is just a name, and reconciling it means
   * pattern-matching names — which is how a tool ends up removing one of the
   * user's own containers.
   */
  buildFragment(instance: ServiceInstance): ComposeFragment {
    const fragment = this.spec.fragment(instance, this.versionFor(instance))
    const definition = fragment.services[this.spec.id] as Record<string, unknown> | undefined
    if (!definition) return fragment

    definition.labels = {
      ...((definition.labels as Record<string, string>) ?? {}),
      'com.harbor.owner': instance.owner,
      'com.harbor.service': instance.serviceId
    }

    // Appended to whatever the fragment already built, not to `commandBase`
    // alone: a spec that turns config fields into flags (MySQL's binlog options)
    // has already put them in `command`, and replacing it would silently drop
    // every setting the user made through the form in favour of the raw ones.
    const extraArgs = parseLines(instance.values[EXTRA_ARGS])
    if (this.spec.commandBase && extraArgs.length) {
      const base = (definition.command as string[] | undefined) ?? this.spec.commandBase
      definition.command = [...base, ...extraArgs]
    }

    const extraEnv = parseEnvLines(instance.values[EXTRA_ENV])
    if (Object.keys(extraEnv).length) {
      definition.environment = {
        ...((definition.environment as Record<string, string>) ?? {}),
        ...extraEnv
      }
    }

    const extraConfig = String(instance.values[EXTRA_CONFIG] ?? '').trim()
    if (this.spec.configMount && extraConfig) {
      const dir = join(this.docker.configDir(instance.owner), instance.serviceId)
      mkdirSync(dir, { recursive: true })
      const host = join(dir, basename(this.spec.configMount))
      writeFileSync(host, `${extraConfig}\n`, 'utf8')
      definition.volumes = [
        ...((definition.volumes as string[]) ?? []),
        `${host}:${this.spec.configMount}:ro`
      ]
    }

    return fragment
  }

  async start(instance: ServiceInstance): Promise<ProcessHandle> {
    const available = await this.docker.available()
    if (!available.ok) throw new Error(available.reason ?? 'Docker is not available')

    return this.docker.start({
      ref: { owner: instance.owner, serviceId: instance.serviceId },
      displayName: this.spec.displayName
    })
  }

  async stop(instance: ServiceInstance): Promise<void> {
    await this.docker.stop({ owner: instance.owner, serviceId: instance.serviceId })
  }

  /**
   * Ports this instance binds on the host. Read straight off the instance,
   * where the allocator wrote them — the driver keeps no notion of "the"
   * running config, which is what made a restarted service report defaults.
   */
  configuredPorts(instance: ServiceInstance): number[] {
    const values = instance.values ?? {}
    const primary = Number(values.port ?? this.spec.defaultPorts[0])
    const rest = this.spec.defaultPorts.slice(1).map((p, i) => {
      const key = ['secondaryPort', 'tertiaryPort'][i]
      return key && values[key] !== undefined ? Number(values[key]) : p
    })
    return [primary, ...rest]
  }

  /**
   * Wait for the container to be usable, then run the spec's reconciliation.
   *
   * The wait is the whole reason this cannot be part of `start()`: a first run
   * pulls an image and initialises a data directory, and MySQL refuses
   * connections for a good while after `up -d` returns.
   *
   * Readiness is decided by retrying the command itself rather than by the
   * health check. Docker's port proxy binds the published port the moment the
   * container starts, so a TCP probe succeeds while the server inside is still
   * initialising — `healthTcp` reports running and the first connection is
   * still refused. Whether the command works is the only honest test of
   * whether the command can be run.
   */
  async bootstrap(instance: ServiceInstance): Promise<void> {
    const step = this.spec.bootstrap?.(instance)
    if (!step) return

    const ref = { owner: instance.owner, serviceId: instance.serviceId }
    let lastError: Error | null = null

    for (let i = 0; i < 120; i++) {
      const state = (await this.docker.containerState(ref).catch(() => null))?.toLowerCase()
      if (state === 'running') {
        try {
          await this.docker.exec(ref, step.command, step.stdin)
          return
        } catch (err) {
          lastError = err as Error
        }
      } else if (!state && i > 5) {
        // The container went away rather than starting; nothing to reconcile.
        return
      }
      await delay(1000)
    }

    throw new Error(
      `${this.spec.displayName}: ${step.label} — ` +
        `not ready after 2 minutes${lastError ? ` (${lastError.message.split('\n')[0]})` : ''}`
    )
  }

  /**
   * Whether the service inside the container will actually answer.
   *
   * Confirmed once per container start; a `docker exec` on every health poll,
   * for every instance, is more subprocess churn than the answer is worth once
   * it is known.
   */
  private async isReady(instance: ServiceInstance): Promise<boolean> {
    if (!this.spec.readyCheck) return true
    const key = `${instance.owner}:${instance.serviceId}`
    if (this.confirmedReady.has(key)) return true

    const ref = { owner: instance.owner, serviceId: instance.serviceId }
    const ok = await this.docker
      .exec(ref, this.spec.readyCheck(instance))
      .then(() => true)
      .catch(() => false)
    if (ok) this.confirmedReady.add(key)
    return ok
  }

  async healthCheck(instance: ServiceInstance): Promise<ServiceStatus> {
    const ref = { owner: instance.owner, serviceId: instance.serviceId }
    const state = await this.docker.containerState(ref)
    if (!state) {
      this.confirmedReady.delete(`${instance.owner}:${instance.serviceId}`)
      return { health: 'stopped', ports: [] }
    }

    const lower = state.toLowerCase()
    if (lower !== 'running') {
      // A stop always passes through here, so the next start re-confirms.
      this.confirmedReady.delete(`${instance.owner}:${instance.serviceId}`)
      return { health: lower === 'restarting' ? 'starting' : 'stopped', ports: [] }
    }

    const ports = this.configuredPorts(instance)
    const healthPort = ports[this.spec.healthPortIndex ?? 0] ?? (ports[0] as number)

    if (this.spec.healthTcp) {
      const open = await portAccepts(healthPort)
      // A container that is up but not yet listening is starting, not broken:
      // Postgres and MySQL both take seconds to initialise on first run.
      if (!open) {
        return { health: 'starting', ports, detail: 'container up, waiting for the port' }
      }

      const ready = await this.isReady(instance)
      return ready
        ? { health: 'running', ports, detail: `accepting connections on :${healthPort}` }
        : { health: 'starting', ports, detail: 'port is open, server still starting' }
    }

    if (!this.spec.healthPath) {
      return { health: 'running', ports, detail: `container ${lower}` }
    }

    // The container can be up long before the service answers; that window is
    // 'starting', not 'unhealthy', or every start would flash red.
    try {
      const res = await fetch(`http://127.0.0.1:${healthPort}${this.spec.healthPath}`, {
        signal: AbortSignal.timeout(2000)
      })
      const accepted = this.spec.healthAcceptStatuses ?? []
      if (res.ok || accepted.includes(res.status)) {
        return { health: 'running', ports, detail: `${this.spec.healthPath} → ${res.status}` }
      }
      return { health: 'unhealthy', ports, error: `HTTP ${res.status}` }
    } catch {
      return { health: 'starting', ports, detail: 'container up, waiting for the service' }
    }
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}

function basename(path: string): string {
  return path.split('/').pop() || 'harbor.conf'
}

/** Textarea → lines, blanks and `#` comments dropped. */
function parseLines(raw: unknown): string[] {
  return String(raw ?? '')
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith('#'))
}

function parseEnvLines(raw: unknown): Record<string, string> {
  const out: Record<string, string> = {}
  for (const line of parseLines(raw)) {
    const eq = line.indexOf('=')
    if (eq <= 0) continue
    out[line.slice(0, eq).trim()] = line.slice(eq + 1).trim()
  }
  return out
}

/** Does anything accept a TCP connection on this port? */
function portAccepts(port: number, timeoutMs = 1500): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = connect({ host: '127.0.0.1', port })
    let done = false
    const settle = (value: boolean): void => {
      if (done) return
      done = true
      clearTimeout(timer)
      socket.destroy()
      resolve(value)
    }
    // Cancelled on settle: a timer left running would overwrite a good result.
    const timer = setTimeout(() => settle(false), timeoutMs)
    socket.once('connect', () => settle(true))
    socket.once('error', () => settle(false))
  })
}

/**
 * A console served on one of the instance's configured ports.
 *
 * Bound to a config field rather than a fixed number: the user can move the
 * port, and a link to where it used to be is worse than no link.
 */
export function consoleAt(
  label: string,
  portField: string,
  path = '/'
): (instance: ServiceInstance) => ServiceConsole | null {
  return (instance) => {
    const port = Number(instance.values[portField])
    return port ? { label, url: `http://127.0.0.1:${port}${path}` } : null
  }
}

/** Port field shared by every Docker service's schema. */
export function portField(title: string, dflt: number): JSONSchema {
  return {
    type: 'integer',
    title,
    section: 'Network',
    format: 'port',
    default: dflt,
    minimum: 1024,
    maximum: 65535
  }
}

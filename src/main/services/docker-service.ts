import type { JSONSchema } from '../../shared/json-schema.js'
import type { LogSource } from '../../shared/logs.js'
import type { ProcessHandle } from '../../shared/process.js'
import type {
  ServiceConfig,
  ServiceDriver,
  ServiceIconKind,
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
  fragment(config: ServiceConfig, version: string): ComposeFragment
  /**
   * Optional HTTP path probed on the first configured port. Container state
   * alone only proves the process exists, not that the service is ready.
   */
  healthPath?: string
  /** Treated as healthy; some services return 503 while still usable locally. */
  healthAcceptStatuses?: number[]
}

export class DockerServiceDriver implements ServiceDriver {
  readonly backend = 'docker' as const
  readonly logSources: LogSource[]

  private running: ServiceConfig | null = null

  constructor(
    private readonly docker: DockerBackend,
    private readonly spec: DockerServiceSpec
  ) {
    this.logSources = [{ kind: 'stdout', label: spec.id }]
  }

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
  get configSchema(): JSONSchema {
    return this.spec.configSchema
  }
  get envHints(): Record<string, string> {
    return this.spec.envHints
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

  private versionFor(config: ServiceConfig): string {
    const first = this.spec.versions[0] as string
    return config.version === 'latest' || !this.spec.versions.includes(config.version)
      ? first
      : config.version
  }

  async start(config: ServiceConfig): Promise<ProcessHandle> {
    const available = await this.docker.available()
    if (!available.ok) throw new Error(available.reason ?? 'Docker is not available')

    this.running = config
    return this.docker.start({
      serviceId: this.spec.id,
      displayName: this.spec.displayName,
      fragment: this.spec.fragment(config, this.versionFor(config))
    })
  }

  async stop(): Promise<void> {
    await this.docker.stop(this.spec.id)
    this.running = null
  }

  private ports(): number[] {
    const values = this.running?.values ?? {}
    const primary = Number(values.port ?? this.spec.defaultPorts[0])
    const rest = this.spec.defaultPorts.slice(1).map((p, i) => {
      const key = ['secondaryPort', 'tertiaryPort'][i]
      return key && values[key] !== undefined ? Number(values[key]) : p
    })
    return [primary, ...rest]
  }

  async healthCheck(): Promise<ServiceStatus> {
    const state = await this.docker.containerState(this.spec.id)
    if (!state) return { health: 'stopped', ports: [] }

    const lower = state.toLowerCase()
    if (lower !== 'running') {
      return { health: lower === 'restarting' ? 'starting' : 'stopped', ports: [] }
    }

    const ports = this.ports()
    if (!this.spec.healthPath) {
      return { health: 'running', ports, detail: `container ${lower}` }
    }

    // The container can be up long before the service answers; that window is
    // 'starting', not 'unhealthy', or every start would flash red.
    try {
      const res = await fetch(`http://127.0.0.1:${ports[0]}${this.spec.healthPath}`, {
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

/** Port field shared by every Docker service's schema. */
export function portField(title: string, dflt: number): JSONSchema {
  return { type: 'integer', title, format: 'port', default: dflt, minimum: 1024, maximum: 65535 }
}

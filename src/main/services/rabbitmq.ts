import type { ProcessHandle } from '../../shared/process.js'
import type { LogSource } from '../../shared/logs.js'
import type { JSONSchema } from '../../shared/json-schema.js'
import type { ServiceConfig, ServiceDriver, ServiceStatus } from '../../shared/service.js'
import type { ComposeFragment, DockerBackend } from '../backends/docker-backend.js'

/**
 * Second backend, same contract. The only thing that differs from MinIO is the
 * body of start/stop/healthCheck — the card, form, logs and .env export are
 * identical machinery.
 */
export class RabbitMqDriver implements ServiceDriver {
  readonly id = 'rabbitmq'
  readonly displayName = 'RabbitMQ'
  readonly description = 'AMQP message broker'
  readonly backend = 'docker' as const
  readonly defaultPorts = [5672, 15672]
  readonly icon = 'queue' as const
  readonly tint = '#FF6600'

  readonly configSchema: JSONSchema = {
    type: 'object',
    properties: {
      port: { type: 'integer', title: 'AMQP port', format: 'port', default: 5672 },
      managementPort: {
        type: 'integer',
        title: 'Management UI port',
        format: 'port',
        default: 15672
      },
      user: { type: 'string', title: 'Username', default: 'guest' },
      password: { type: 'string', title: 'Password', format: 'password', default: 'guest' },
      vhost: { type: 'string', title: 'Virtual host', default: '/' }
    },
    required: ['port', 'user', 'password']
  }

  readonly logSources: LogSource[] = [{ kind: 'stdout', label: 'rabbitmq' }]

  readonly envHints: Record<string, string> = {
    RABBITMQ_HOST: '${host}',
    RABBITMQ_PORT: '${port}',
    RABBITMQ_USER: '${user}',
    RABBITMQ_PASSWORD: '${password}',
    RABBITMQ_VHOST: '${vhost}'
  }

  private running: ServiceConfig | null = null

  constructor(private readonly docker: DockerBackend) {}

  async availableVersions(): Promise<string[]> {
    return ['4-management', '3.13-management']
  }

  async installedVersions(): Promise<string[]> {
    // For Docker services "installed" means the image is pulled; compose pulls
    // on first up, so we report the configured tag optimistically.
    return this.availableVersions()
  }

  async install(): Promise<void> {
    // No-op: `docker compose up -d` pulls the image on demand.
  }

  private fragment(config: ServiceConfig): ComposeFragment {
    const version = config.version === 'latest' ? '4-management' : config.version
    return {
      services: {
        rabbitmq: {
          image: `rabbitmq:${version}`,
          container_name: 'harbor-rabbitmq',
          ports: [
            `${config.values.port ?? 5672}:5672`,
            `${config.values.managementPort ?? 15672}:15672`
          ],
          environment: {
            RABBITMQ_DEFAULT_USER: String(config.values.user ?? 'guest'),
            RABBITMQ_DEFAULT_PASS: String(config.values.password ?? 'guest'),
            RABBITMQ_DEFAULT_VHOST: String(config.values.vhost ?? '/')
          },
          volumes: ['harbor-rabbitmq:/var/lib/rabbitmq'],
          restart: 'unless-stopped'
        }
      },
      volumes: { 'harbor-rabbitmq': {} }
    }
  }

  configuredPorts(config: ServiceConfig): number[] {
    return [
      Number(config.values.port ?? 5672),
      Number(config.values.managementPort ?? 15672)
    ]
  }

  async start(config: ServiceConfig): Promise<ProcessHandle> {
    this.running = config
    return this.docker.start({
      serviceId: this.id,
      displayName: this.displayName,
      fragment: this.fragment(config)
    })
  }

  async stop(): Promise<void> {
    await this.docker.stop(this.id)
    this.running = null
  }

  async healthCheck(): Promise<ServiceStatus> {
    const state = await this.docker.containerState(this.id)
    if (!state) return { health: 'stopped', ports: [] }
    const port = Number(this.running?.values.port ?? 5672)
    const mgmt = Number(this.running?.values.managementPort ?? 15672)
    if (state.toLowerCase() === 'running') {
      return { health: 'running', ports: [port, mgmt], detail: `management UI on :${mgmt}` }
    }
    return { health: state.toLowerCase() === 'restarting' ? 'starting' : 'stopped', ports: [] }
  }
}

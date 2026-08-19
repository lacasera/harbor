import { chmodSync, existsSync, mkdirSync, readdirSync } from 'node:fs'
import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import type { ProcessHandle } from '../../shared/process.js'
import type { LogSource } from '../../shared/logs.js'
import type { JSONSchema } from '../../shared/json-schema.js'
import type { ServiceConfig, ServiceDriver, ServiceStatus } from '../../shared/service.js'
import type { NativeBackend } from '../backends/native-backend.js'
import type { ProcessManager } from '../core/process-manager.js'
import { serviceDataDir, serviceDir, serviceLogFile } from '../core/paths.js'

/** MinIO publishes per-arch binaries; picking the wrong one fails at exec time. */
const DOWNLOAD_URL = `https://dl.min.io/server/minio/release/darwin-${
  process.arch === 'arm64' ? 'arm64' : 'amd64'
}/minio`

/**
 * First ServiceDriver, and the one the abstraction was designed against: native
 * backend, two ports, credentials, a data dir, and an S3-shaped .env block.
 */
export class MinioDriver implements ServiceDriver {
  readonly id = 'minio'
  readonly displayName = 'MinIO'
  readonly description = 'S3-compatible object storage'
  readonly backend = 'native' as const
  readonly defaultPorts = [9000, 9001]
  readonly icon = 'storage' as const
  readonly tint = '#C72E49'

  readonly configSchema: JSONSchema = {
    type: 'object',
    properties: {
      port: {
        type: 'integer',
        title: 'API port',
        format: 'port',
        default: 9000,
        minimum: 1024,
        maximum: 65535
      },
      consolePort: {
        type: 'integer',
        title: 'Console port',
        format: 'port',
        default: 9001,
        minimum: 1024,
        maximum: 65535
      },
      rootUser: { type: 'string', title: 'Root user', default: 'minioadmin', minLength: 3 },
      rootPassword: {
        type: 'string',
        title: 'Root password',
        format: 'password',
        default: 'minioadmin',
        minLength: 8
      },
      region: { type: 'string', title: 'Region', default: 'us-east-1' },
      dataDir: { type: 'string', title: 'Data directory', format: 'directory', default: '' }
    },
    required: ['port', 'consolePort', 'rootUser', 'rootPassword']
  }

  readonly logSources: LogSource[] = [
    { kind: 'stdout', label: 'minio' },
    { kind: 'file', path: serviceLogFile('minio'), label: 'minio.log' }
  ]

  /**
   * Templates resolved against the live ServiceConfig at export time — never
   * against these defaults. See ServiceRegistry.envBlock.
   */
  readonly envHints: Record<string, string> = {
    AWS_ACCESS_KEY_ID: '${rootUser}',
    AWS_SECRET_ACCESS_KEY: '${rootPassword}',
    AWS_DEFAULT_REGION: '${region}',
    AWS_BUCKET: 'local',
    AWS_ENDPOINT: 'http://${host}:${port}',
    AWS_URL: 'http://${host}:${port}/local',
    AWS_USE_PATH_STYLE_ENDPOINT: 'true'
  }

  /** Config of the currently running instance — health must probe live ports. */
  private running: ServiceConfig | null = null

  constructor(
    private readonly native: NativeBackend,
    private readonly processes: ProcessManager
  ) {}

  async availableVersions(): Promise<string[]> {
    // MinIO ships a rolling binary rather than tagged downloads.
    return ['latest']
  }

  async installedVersions(): Promise<string[]> {
    const dir = serviceDir(this.id)
    if (!existsSync(dir)) return []
    return readdirSync(dir).filter((v) => existsSync(this.binaryPath(v)))
  }

  binaryPath(version: string): string {
    return join(serviceDir(this.id), version, 'minio')
  }

  async install(version: string): Promise<void> {
    const target = this.binaryPath(version)
    mkdirSync(join(serviceDir(this.id), version), { recursive: true })

    const res = await fetch(DOWNLOAD_URL)
    if (!res.ok || !res.body) throw new Error(`MinIO download failed: HTTP ${res.status}`)
    await writeFile(target, Readable.fromWeb(res.body as Parameters<typeof Readable.fromWeb>[0]))
    chmodSync(target, 0o755)
  }

  configuredPorts(config: ServiceConfig): number[] {
    return [Number(config.values.port ?? 9000), Number(config.values.consolePort ?? 9001)]
  }

  async start(config: ServiceConfig): Promise<ProcessHandle> {
    const versions = await this.installedVersions()
    const version = versions.includes(config.version) ? config.version : versions[0]
    if (!version) throw new Error('MinIO is not installed yet')

    const data = (config.values.dataDir as string) || serviceDataDir(this.id)
    mkdirSync(data, { recursive: true })

    this.running = config
    return this.native.start({
      serviceId: this.id,
      displayName: this.displayName,
      command: this.binaryPath(version),
      args: [
        'server',
        data,
        '--address',
        `:${config.values.port ?? 9000}`,
        '--console-address',
        `:${config.values.consolePort ?? 9001}`
      ],
      env: {
        MINIO_ROOT_USER: String(config.values.rootUser ?? 'minioadmin'),
        MINIO_ROOT_PASSWORD: String(config.values.rootPassword ?? 'minioadmin'),
        MINIO_REGION: String(config.values.region ?? 'us-east-1')
      }
    })
  }

  async stop(): Promise<void> {
    await this.native.stop(this.id)
    this.running = null
  }

  async healthCheck(): Promise<ServiceStatus> {
    const handle = this.processes.findByOwner('service', this.id)
    if (!handle) return { health: 'stopped', ports: [] }

    const port = Number(this.running?.values.port ?? 9000)
    const consolePort = Number(this.running?.values.consolePort ?? 9001)
    try {
      const res = await fetch(`http://127.0.0.1:${port}/minio/health/live`, {
        signal: AbortSignal.timeout(1500)
      })
      if (res.ok) {
        return {
          health: 'running',
          ports: [port, consolePort],
          detail: `console on :${consolePort}`
        }
      }
      return { health: 'unhealthy', ports: [port], error: `HTTP ${res.status}` }
    } catch {
      return handle.state === 'starting'
        ? { health: 'starting', ports: [] }
        : { health: 'unhealthy', ports: [], error: 'health endpoint unreachable' }
    }
  }
}

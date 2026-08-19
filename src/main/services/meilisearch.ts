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
import { serviceDataDir, serviceDir } from '../core/paths.js'

const RELEASES = 'https://api.github.com/repos/meilisearch/meilisearch/releases'

/**
 * Native, like MinIO: a single binary, fast to start, and one of the services
 * developers leave running all day — not worth a container.
 */
export class MeilisearchDriver implements ServiceDriver {
  readonly id = 'meilisearch'
  readonly displayName = 'Meilisearch'
  readonly description = 'Typo-tolerant search engine'
  readonly backend = 'native' as const
  readonly defaultPorts = [7700]
  readonly icon = 'search' as const
  readonly tint = '#FF5CAA'

  readonly configSchema: JSONSchema = {
    type: 'object',
    properties: {
      port: {
        type: 'integer',
        title: 'HTTP port',
        format: 'port',
        default: 7700,
        minimum: 1024,
        maximum: 65535
      },
      masterKey: {
        type: 'string',
        title: 'Master key',
        format: 'password',
        description: 'Required for every write operation',
        default: 'harbor-local-master-key',
        minLength: 16
      },
      env: {
        type: 'string',
        title: 'Environment',
        description: 'development disables the key requirement for reads',
        enum: ['development', 'production'],
        default: 'development'
      },
      dataDir: {
        type: 'string',
        title: 'Data directory',
        format: 'directory',
        description: 'Where indexes are persisted between restarts',
        default: ''
      }
    },
    required: ['port', 'masterKey']
  }

  readonly logSources: LogSource[] = [{ kind: 'stdout', label: 'meilisearch' }]

  readonly envHints: Record<string, string> = {
    SCOUT_DRIVER: 'meilisearch',
    MEILISEARCH_HOST: 'http://${host}:${port}',
    MEILISEARCH_KEY: '${masterKey}',
    MEILI_MASTER_KEY: '${masterKey}'
  }

  private running: ServiceConfig | null = null
  private arch = process.arch === 'arm64' ? 'apple-silicon' : 'amd64'

  constructor(
    private readonly native: NativeBackend,
    private readonly processes: ProcessManager
  ) {}

  async availableVersions(): Promise<string[]> {
    const res = await fetch(`${RELEASES}?per_page=20`, {
      headers: { accept: 'application/vnd.github+json' },
      signal: AbortSignal.timeout(10_000)
    })
    if (!res.ok) throw new Error(`Meilisearch version list failed: HTTP ${res.status}`)
    const releases = (await res.json()) as Array<{ tag_name: string; prerelease: boolean }>
    return releases.filter((r) => !r.prerelease).map((r) => r.tag_name.replace(/^v/, ''))
  }

  async installedVersions(): Promise<string[]> {
    const dir = serviceDir(this.id)
    if (!existsSync(dir)) return []
    return readdirSync(dir).filter((v) => existsSync(this.binaryPath(v)))
  }

  binaryPath(version: string): string {
    return join(serviceDir(this.id), version, 'meilisearch')
  }

  async install(version: string): Promise<void> {
    const resolved = version === 'latest' ? ((await this.availableVersions())[0] ?? '') : version
    if (!resolved) throw new Error('Could not determine a Meilisearch version to install')

    const target = this.binaryPath(resolved)
    mkdirSync(join(serviceDir(this.id), resolved), { recursive: true })

    const url = `https://github.com/meilisearch/meilisearch/releases/download/v${resolved}/meilisearch-macos-${this.arch}`
    const res = await fetch(url, { redirect: 'follow' })
    if (!res.ok || !res.body) {
      throw new Error(`Meilisearch ${resolved} download failed: HTTP ${res.status}`)
    }
    await writeFile(target, Readable.fromWeb(res.body as Parameters<typeof Readable.fromWeb>[0]))
    chmodSync(target, 0o755)
  }

  async start(config: ServiceConfig): Promise<ProcessHandle> {
    const versions = await this.installedVersions()
    const version = versions.includes(config.version) ? config.version : versions[0]
    if (!version) throw new Error('Meilisearch is not installed yet')

    const data = (config.values.dataDir as string) || serviceDataDir(this.id)
    mkdirSync(data, { recursive: true })

    this.running = config
    return this.native.start({
      serviceId: this.id,
      displayName: this.displayName,
      command: this.binaryPath(version),
      args: [
        '--http-addr',
        `127.0.0.1:${config.values.port ?? 7700}`,
        '--db-path',
        join(data, 'data.ms'),
        '--dump-dir',
        join(data, 'dumps'),
        '--env',
        String(config.values.env ?? 'development')
      ],
      env: { MEILI_MASTER_KEY: String(config.values.masterKey ?? '') }
    })
  }

  async stop(): Promise<void> {
    await this.native.stop(this.id)
    this.running = null
  }

  async healthCheck(): Promise<ServiceStatus> {
    const handle = this.processes.findByOwner('service', this.id)
    if (!handle) return { health: 'stopped', ports: [] }

    const port = Number(this.running?.values.port ?? 7700)
    try {
      const res = await fetch(`http://127.0.0.1:${port}/health`, {
        signal: AbortSignal.timeout(1500)
      })
      if (res.ok) return { health: 'running', ports: [port], detail: 'health → available' }
      return { health: 'unhealthy', ports: [port], error: `HTTP ${res.status}` }
    } catch {
      return handle.state === 'starting'
        ? { health: 'starting', ports: [] }
        : { health: 'unhealthy', ports: [], error: 'health endpoint unreachable' }
    }
  }
}

import { chmodSync, existsSync, mkdirSync, readdirSync } from 'node:fs'
import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import type { ProcessHandle } from '../../shared/process.js'
import type { LogSource } from '../../shared/logs.js'
import type { JSONSchema } from '../../shared/json-schema.js'
import {
  instanceKey,
  type ServiceConsole,
  type ServiceDriver,
  type ServiceInstance,
  type ServiceInstanceRef,
  type ServiceStatus
} from '../../shared/service.js'
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

  logSources(ref: ServiceInstanceRef): LogSource[] {
    return [{ kind: 'stdout', label: instanceKey(ref) }]
  }

  readonly envHints: Record<string, string> = {
    SCOUT_DRIVER: 'meilisearch',
    MEILISEARCH_HOST: 'http://${host}:${port}',
    MEILISEARCH_KEY: '${masterKey}',
    MEILI_MASTER_KEY: '${masterKey}'
  }

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

  /**
   * Meilisearch bundles a search preview at the root, but only serves it in the
   * development environment. Offering the link in production would open a page
   * that isn't there, which is worse than offering nothing.
   */
  console(instance: ServiceInstance): ServiceConsole | null {
    if (String(instance.values.env ?? 'development') !== 'development') return null
    return {
      label: 'Open dashboard',
      url: `http://127.0.0.1:${Number(instance.values.port ?? 7700)}`
    }
  }

  configuredPorts(instance: ServiceInstance): number[] {
    return [Number(instance.values.port ?? 7700)]
  }

  async start(instance: ServiceInstance): Promise<ProcessHandle> {
    const versions = await this.installedVersions()
    const version = versions.includes(instance.version) ? instance.version : versions[0]
    if (!version) throw new Error('Meilisearch is not installed yet')

    const data =
      (instance.values.dataDir as string) || serviceDataDir(instance.owner, instance.serviceId)
    mkdirSync(data, { recursive: true })

    return this.native.start({
      ref: { owner: instance.owner, serviceId: instance.serviceId },
      displayName: this.displayName,
      command: this.binaryPath(version),
      args: [
        '--http-addr',
        `127.0.0.1:${instance.values.port ?? 7700}`,
        '--db-path',
        join(data, 'data.ms'),
        '--dump-dir',
        join(data, 'dumps'),
        '--env',
        String(instance.values.env ?? 'development')
      ],
      env: { MEILI_MASTER_KEY: String(instance.values.masterKey ?? '') }
    })
  }

  async stop(instance: ServiceInstance): Promise<void> {
    await this.native.stop({ owner: instance.owner, serviceId: instance.serviceId })
  }

  async healthCheck(instance: ServiceInstance): Promise<ServiceStatus> {
    const handle = this.processes.findByOwner('service', instanceKey(instance))
    if (!handle) return { health: 'stopped', ports: [] }

    const port = Number(instance.values.port ?? 7700)
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

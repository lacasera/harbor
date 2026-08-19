import { exec as execCb } from 'node:child_process'
import { promisify } from 'node:util'
import { writeFileSync, mkdirSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import type { ProcessHandle } from '../../shared/process.js'
import type { ProcessManager } from '../core/process-manager.js'
import { paths } from '../core/paths.js'
import type { Backend, BackendStartOptions } from './types.js'

const exec = promisify(execCb)

/** One service's slice of the merged compose file. */
export interface ComposeFragment {
  services: Record<string, unknown>
  volumes?: Record<string, unknown>
}

/**
 * Colima is preferred over Docker Desktop — lighter and scriptable. Heavy
 * services (Elasticsearch, Kafka, RabbitMQ, LocalStack) live here.
 */
export interface DockerStartOptions extends BackendStartOptions {
  fragment?: ComposeFragment
}

export class DockerBackend implements Backend<DockerStartOptions> {
  readonly id = 'docker' as const
  private readonly fragments = new Map<string, ComposeFragment>()

  constructor(private readonly processes: ProcessManager) {}

  async available(): Promise<{ ok: boolean; reason?: string }> {
    const docker = await this.probe('docker version --format "{{.Server.Version}}"')
    if (docker) return { ok: true }
    const colima = await this.probe('colima status')
    if (colima) return { ok: false, reason: 'Colima is installed but not running — start it first' }
    return { ok: false, reason: 'No Docker daemon. Install Colima: brew install colima' }
  }

  async colimaStart(): Promise<void> {
    await exec('colima start --cpu 2 --memory 4', { maxBuffer: 16 * 1024 * 1024 })
  }

  register(serviceId: string, fragment: ComposeFragment): void {
    this.fragments.set(serviceId, fragment)
  }

  /** Merge every registered fragment into one compose file on disk. */
  private writeComposeFile(): string {
    if (!existsSync(paths.compose)) mkdirSync(paths.compose, { recursive: true })
    const merged: { services: Record<string, unknown>; volumes: Record<string, unknown> } = {
      services: {},
      volumes: {}
    }
    for (const fragment of this.fragments.values()) {
      Object.assign(merged.services, fragment.services)
      Object.assign(merged.volumes, fragment.volumes ?? {})
    }
    const file = join(paths.compose, 'docker-compose.json')
    writeFileSync(file, JSON.stringify(merged, null, 2), 'utf8')
    return file
  }

  async start(options: DockerStartOptions): Promise<ProcessHandle> {
    if (options.fragment) this.register(options.serviceId, options.fragment)
    const file = this.writeComposeFile()
    await exec(`docker compose -f "${file}" up -d ${options.serviceId}`, {
      maxBuffer: 16 * 1024 * 1024
    })

    // Container logs are streamed through ProcessManager so they land in the
    // unified viewer exactly like a native service's stdout.
    return this.processes.spawn({
      owner: { kind: 'service', id: options.serviceId },
      label: options.displayName,
      command: 'docker',
      args: ['compose', '-f', file, 'logs', '-f', '--no-color', options.serviceId]
    })
  }

  async stop(serviceId: string): Promise<void> {
    const handle = this.processes.findByOwner('service', serviceId)
    if (handle) await this.processes.stop(handle.id)
    const file = join(paths.compose, 'docker-compose.json')
    if (existsSync(file)) {
      await exec(`docker compose -f "${file}" stop ${serviceId}`).catch(() => undefined)
    }
  }

  async containerState(serviceId: string): Promise<string | null> {
    const file = join(paths.compose, 'docker-compose.json')
    if (!existsSync(file)) return null
    try {
      const { stdout } = await exec(`docker compose -f "${file}" ps --format json ${serviceId}`)
      const first = stdout.trim().split('\n')[0]
      if (!first) return null
      return (JSON.parse(first) as { State?: string }).State ?? null
    } catch {
      return null
    }
  }

  private async probe(cmd: string): Promise<boolean> {
    try {
      await exec(cmd)
      return true
    } catch {
      return false
    }
  }
}

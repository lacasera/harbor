import { exec as execCb, spawn } from 'node:child_process'
import { promisify } from 'node:util'
import { writeFileSync, mkdirSync, existsSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import type { ProcessHandle } from '../../shared/process.js'
import { instanceKey, type ServiceInstanceRef, type ServiceOwnerId } from '../../shared/service.js'
import type { ProcessManager } from '../core/process-manager.js'
import { composeDir } from '../core/paths.js'
import type { Backend, BackendStartOptions } from './types.js'

const exec = promisify(execCb)

/** One service's slice of its owner's compose file. */
export interface ComposeFragment {
  services: Record<string, unknown>
  volumes?: Record<string, unknown>
}

/**
 * Everything needed to render one owner's compose file, resolved from
 * persisted state on demand.
 */
export interface DockerStack {
  /** Compose project name — the `-p` flag, and the namespace for volumes. */
  composeProject: string
  /** Every service in this owner's stack, keyed by service id. */
  fragments: Record<string, ComposeFragment>
}

/**
 * Resolves an owner to its full stack. Injected rather than looked up, so the
 * backend stays ignorant of projects and instances — it renders and runs
 * compose, nothing else.
 */
export type StackResolver = (owner: ServiceOwnerId) => DockerStack

export interface DockerStartOptions extends BackendStartOptions {}

/**
 * Colima is preferred over Docker Desktop — lighter and scriptable. Heavy
 * services (Elasticsearch, Kafka, RabbitMQ, LocalStack) live here.
 *
 * One compose project per owner. That is what lets two projects each run their
 * own MySQL: compose namespaces container names and volumes by project, so
 * `harbor-shop` and `harbor-blog` get separate containers and separate data
 * without either knowing the other exists.
 */
export class DockerBackend implements Backend<DockerStartOptions> {
  readonly id = 'docker' as const
  private resolveStack: StackResolver = () => ({ composeProject: '', fragments: {} })

  constructor(private readonly processes: ProcessManager) {}

  /** Wired after construction — the instance store is built later than this. */
  setStackResolver(resolver: StackResolver): void {
    this.resolveStack = resolver
  }

  async available(): Promise<{ ok: boolean; reason?: string }> {
    // "Not installed" and "installed but not running" are different problems
    // with different fixes, and a third — "installed, running, but this process
    // cannot see it" — is the one that actually happens. A GUI-launched app
    // gets launchd's PATH, so `docker` at /usr/local/bin is invisible to it and
    // every failure reported as "no Docker daemon" on a machine running one.
    const cli = await this.probe('command -v docker')
    if (!cli) {
      return {
        ok: false,
        reason:
          'The docker command was not found. Install Docker Desktop or Colima ' +
          '(brew install colima), then restart Harbor.'
      }
    }

    if (await this.probe('docker version --format "{{.Server.Version}}"')) return { ok: true }

    const colima = await this.probe('colima status')
    return {
      ok: false,
      reason: colima
        ? 'Colima is installed but not running — start it with: colima start'
        : 'Docker is installed but its daemon is not responding — start Docker Desktop or Colima'
    }
  }

  async colimaStart(): Promise<void> {
    await exec('colima start --cpu 2 --memory 4', { maxBuffer: 16 * 1024 * 1024 })
  }

  /**
   * Render an owner's compose file from persisted state, every time.
   *
   * The previous design accumulated fragments in a `fragments.json` cache
   * because a service only supplied its fragment when starting, so writing the
   * file from what was in memory dropped every other service's definition. With
   * instances persisted, the file can simply be regenerated — and a file that
   * is always a complete rendering of state cannot drift from it.
   */
  private writeComposeFile(owner: ServiceOwnerId): { file: string; project: string } {
    const stack = this.resolveStack(owner)
    const dir = composeDir(stack.composeProject)
    mkdirSync(dir, { recursive: true })

    const merged: { services: Record<string, unknown>; volumes: Record<string, unknown> } = {
      services: {},
      volumes: {}
    }
    for (const fragment of Object.values(stack.fragments)) {
      Object.assign(merged.services, fragment.services)
      Object.assign(merged.volumes, fragment.volumes ?? {})
    }

    const file = join(dir, 'docker-compose.json')
    writeFileSync(file, JSON.stringify(merged, null, 2), 'utf8')
    return { file, project: stack.composeProject }
  }

  /**
   * Where an owner's mounted config files live. Alongside its compose file, so
   * tearing a stack down with `--volumes` removes its configuration with it.
   */
  configDir(owner: ServiceOwnerId): string {
    return join(composeDir(this.resolveStack(owner).composeProject), 'conf')
  }

  private composeFile(owner: ServiceOwnerId): { file: string; project: string } | null {
    const stack = this.resolveStack(owner)
    if (!stack.composeProject) return null
    const file = join(composeDir(stack.composeProject), 'docker-compose.json')
    return existsSync(file) ? { file, project: stack.composeProject } : null
  }

  async start(options: DockerStartOptions): Promise<ProcessHandle> {
    const { ref, displayName } = options
    const { file, project } = this.writeComposeFile(ref.owner)
    await exec(`docker compose -p ${project} -f "${file}" up -d ${ref.serviceId}`, {
      maxBuffer: 16 * 1024 * 1024
    })

    // Container logs are streamed through ProcessManager so they land in the
    // unified viewer exactly like a native service's stdout.
    return this.processes.spawn({
      owner: { kind: 'service', id: instanceKey(ref) },
      label: displayName,
      command: 'docker',
      args: [
        'compose',
        '-p',
        project,
        '-f',
        file,
        'logs',
        '-f',
        '--no-color',
        '--tail',
        '50',
        ref.serviceId
      ]
    })
  }

  async stop(ref: ServiceInstanceRef): Promise<void> {
    const handle = this.processes.findByOwner('service', instanceKey(ref))
    if (handle) await this.processes.stop(handle.id)
    const compose = this.composeFile(ref.owner)
    if (!compose) return
    await exec(
      `docker compose -p ${compose.project} -f "${compose.file}" stop ${ref.serviceId}`
    ).catch(() => undefined)
  }

  async containerState(ref: ServiceInstanceRef): Promise<string | null> {
    const compose = this.composeFile(ref.owner)
    if (!compose) return null
    try {
      const { stdout } = await exec(
        `docker compose -p ${compose.project} -f "${compose.file}" ps --format json ${ref.serviceId}`
      )
      const first = stdout.trim().split('\n')[0]
      if (!first) return null
      return (JSON.parse(first) as { State?: string }).State ?? null
    } catch {
      return null
    }
  }

  /**
   * Run a command inside a running container, optionally feeding it stdin.
   *
   * Used for the reconciliation an image can only do at first initialisation —
   * creating a database, granting a user — which has to happen from outside
   * once a volume exists.
   */
  async exec(ref: ServiceInstanceRef, command: string[], stdin?: string): Promise<string> {
    const compose = this.composeFile(ref.owner)
    if (!compose) throw new Error(`No compose file for ${ref.owner}`)
    return new Promise<string>((resolve, reject) => {
      const child = spawn('docker', [
        'compose',
        '-p',
        compose.project,
        '-f',
        compose.file,
        'exec',
        // No TTY: this is piped input, and an allocated TTY mangles it.
        '-T',
        ref.serviceId,
        ...command
      ])
      let out = ''
      let err = ''
      child.stdout.on('data', (c: Buffer) => (out += c.toString()))
      child.stderr.on('data', (c: Buffer) => (err += c.toString()))
      child.on('error', reject)
      child.on('close', (code) =>
        code === 0 ? resolve(out) : reject(new Error(err.trim() || `exit ${code}`))
      )
      if (stdin !== undefined) child.stdin.end(stdin)
      else child.stdin.end()
    })
  }

  /**
   * Tear down a whole compose project. Scoped by project name and never by a
   * container name pattern — the user runs their own compose stacks on this
   * machine, and a pattern match is how a tool ends up killing one of them.
   *
   * Volumes are kept unless explicitly asked for: removing them destroys the
   * user's database, which must stay a deliberate action.
   */
  async down(composeProject: string, options: { volumes?: boolean } = {}): Promise<void> {
    const file = join(composeDir(composeProject), 'docker-compose.json')
    const flags = options.volumes ? ' --volumes' : ''
    const target = existsSync(file) ? `-f "${file}"` : ''
    await exec(`docker compose -p ${composeProject} ${target} down${flags}`, {
      maxBuffer: 16 * 1024 * 1024
    }).catch(() => undefined)
    if (options.volumes) rmSync(composeDir(composeProject), { recursive: true, force: true })
  }

  /** Compose projects the daemon currently knows about, by name. */
  async listProjects(): Promise<string[]> {
    try {
      const { stdout } = await exec('docker compose ls --all --format json', {
        maxBuffer: 16 * 1024 * 1024
      })
      const parsed = JSON.parse(stdout) as Array<{ Name?: string }>
      return parsed.map((p) => p.Name ?? '').filter(Boolean)
    } catch {
      return []
    }
  }

  /** Named volumes belonging to a compose project, e.g. after a teardown. */
  async listVolumes(composeProject: string): Promise<string[]> {
    try {
      const { stdout } = await exec(
        `docker volume ls --filter label=com.docker.compose.project=${composeProject} --format "{{.Name}}"`
      )
      return stdout.trim().split('\n').filter(Boolean)
    } catch {
      return []
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


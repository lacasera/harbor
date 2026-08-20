import { execFile as execFileCb, spawn } from 'node:child_process'
import { promisify } from 'node:util'
import { writeFileSync, mkdirSync, existsSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import type { ProcessHandle } from '../../shared/process.js'
import { instanceKey, type ServiceInstanceRef, type ServiceOwnerId } from '../../shared/service.js'
import type { ProcessManager } from '../core/process-manager.js'
import { composeDir } from '../core/paths.js'
import type { ContainerRuntimes } from '../containers/index.js'
import type { Backend, BackendStartOptions } from './types.js'

const execFile = promisify(execFileCb)

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

  constructor(
    private readonly processes: ProcessManager,
    private readonly runtimes: ContainerRuntimes
  ) {}

  /**
   * The CLI for the selected runtime.
   *
   * Docker Desktop, OrbStack and Colima all answer to `docker` and are told
   * apart by the context this sets; Podman has its own CLI entirely. Every
   * compose call goes through here so none of the callers has to know which is
   * in use.
   */
  private async cli(): Promise<{ bin: string; compose: string[]; env: NodeJS.ProcessEnv }> {
    const invocation = await this.runtimes.invocation()
    if (!invocation) {
      throw new Error((await this.runtimes.unavailableReason()) ?? 'No container runtime available')
    }
    return {
      bin: invocation.bin,
      compose: invocation.compose,
      env: { ...process.env, ...invocation.env }
    }
  }

  /** Run a compose command against one owner's file. */
  private async compose(project: string, file: string, args: string[]): Promise<string> {
    const { bin, compose, env } = await this.cli()
    const { stdout } = await execFile(bin, [...compose, '-p', project, '-f', file, ...args], {
      env,
      maxBuffer: 16 * 1024 * 1024
    })
    return stdout
  }

  /** Wired after construction — the instance store is built later than this. */
  setStackResolver(resolver: StackResolver): void {
    this.resolveStack = resolver
  }

  /**
   * Whether containers can run at all. The reason comes from the runtime
   * registry, which knows which one is selected and what is wrong with it —
   * "not installed", "not running" and "no runtime at all" need different
   * answers, and naming a product the user has not chosen just misleads them.
   */
  async available(): Promise<{ ok: boolean; reason?: string }> {
    const reason = await this.runtimes.unavailableReason()
    return reason ? { ok: false, reason } : { ok: true }
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
    await this.compose(project, file, ['up', '-d', ref.serviceId])
    const { bin, compose, env } = await this.cli()

    // Container logs are streamed through ProcessManager so they land in the
    // unified viewer exactly like a native service's stdout.
    return this.processes.spawn({
      owner: { kind: 'service', id: instanceKey(ref) },
      label: displayName,
      command: bin,
      args: [...compose, '-p', project, '-f', file, 'logs', '-f', '--no-color', '--tail', '50', ref.serviceId],
      env: env as Record<string, string>
    })
  }

  async stop(ref: ServiceInstanceRef): Promise<void> {
    const handle = this.processes.findByOwner('service', instanceKey(ref))
    if (handle) await this.processes.stop(handle.id)
    const compose = this.composeFile(ref.owner)
    if (!compose) return
    await this.compose(compose.project, compose.file, ['stop', ref.serviceId]).catch(
      () => undefined
    )
  }

  async containerState(ref: ServiceInstanceRef): Promise<string | null> {
    const compose = this.composeFile(ref.owner)
    if (!compose) return null
    try {
      const stdout = await this.compose(compose.project, compose.file, [
        'ps',
        '--format',
        'json',
        ref.serviceId
      ])
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
    const { bin, compose: composeArgs, env } = await this.cli()
    return new Promise<string>((resolve, reject) => {
      const child = spawn(bin, [
        ...composeArgs,
        '-p',
        compose.project,
        '-f',
        compose.file,
        'exec',
        // No TTY: this is piped input, and an allocated TTY mangles it.
        '-T',
        ref.serviceId,
        ...command
      ], { env })
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
    const { bin, compose, env } = await this.cli().catch(() => null) ?? {}
    if (!bin || !compose) return
    const args = [
      ...compose,
      '-p',
      composeProject,
      ...(existsSync(file) ? ['-f', file] : []),
      'down',
      ...(options.volumes ? ['--volumes'] : [])
    ]
    await execFile(bin, args, { env, maxBuffer: 16 * 1024 * 1024 }).catch(() => undefined)
    if (options.volumes) rmSync(composeDir(composeProject), { recursive: true, force: true })
  }

  /** Compose projects the daemon currently knows about, by name. */
  async listProjects(): Promise<string[]> {
    try {
      const { bin, compose, env } = await this.cli()
      const { stdout } = await execFile(bin, [...compose, 'ls', '--all', '--format', 'json'], {
        env,
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
      const { bin, env } = await this.cli()
      const { stdout } = await execFile(
        bin,
        [
          'volume',
          'ls',
          '--filter',
          `label=com.docker.compose.project=${composeProject}`,
          '--format',
          '{{.Name}}'
        ],
        { env }
      )
      return stdout.trim().split('\n').filter(Boolean)
    } catch {
      return []
    }
  }

}


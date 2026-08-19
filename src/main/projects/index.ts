import { EventEmitter } from 'node:events'
import { existsSync, readdirSync, statSync } from 'node:fs'
import { basename, join } from 'node:path'
import { randomUUID } from 'node:crypto'
import type {
  Project,
  ProjectDescriptor,
  ProjectType,
  ProjectTypeId
} from '../../shared/project.js'
import type { ResolvedVersion, RuntimeId } from '../../shared/runtime.js'
import type { ConfigStore } from '../core/config-store.js'
import type { ProcessManager } from '../core/process-manager.js'
import type { PortAllocator } from '../core/port-allocator.js'
import type { RuntimeManager } from '../runtimes/index.js'
import type { PhpRuntime } from '../runtimes/php.js'
import type { NativeBackend } from '../backends/native-backend.js'
import type { PrivilegedHelper } from '../core/privileged-helper.js'
import { paths } from '../core/paths.js'
import { NginxManager, type VhostContext } from './nginx-manager.js'
import { PhpFrameworkRegistry, createPhpFrameworkRegistry } from './php-frameworks/index.js'
import { PhpProjectType } from './types/php.js'
import { NodeServerProjectType } from './types/node-server.js'
import { StaticProjectType } from './types/static.js'

export interface ProjectManagerDeps {
  store: ConfigStore
  processes: ProcessManager
  ports: PortAllocator
  runtimes: RuntimeManager
  php: PhpRuntime
  native: NativeBackend
  privileged: PrivilegedHelper
}

export class ProjectManager extends EventEmitter {
  private readonly types: ProjectType[] = []
  readonly frameworks: PhpFrameworkRegistry = createPhpFrameworkRegistry()
  readonly nginx: NginxManager
  private readonly staticType = new StaticProjectType()

  constructor(private readonly deps: ProjectManagerDeps) {
    super()
    this.nginx = new NginxManager(deps.native, deps.privileged)
    this.registerType(new PhpProjectType(deps.php))
    this.registerType(new NodeServerProjectType())
    this.registerType(this.staticType)
  }

  registerType(type: ProjectType): void {
    this.types.push(type)
    this.types.sort((a, b) => b.priority - a.priority)
  }

  typeById(id: ProjectTypeId): ProjectType {
    const type = this.types.find((t) => t.id === id)
    if (!type) throw new Error(`Unknown project type: ${id}`)
    return type
  }

  listTypes(): Array<{ id: ProjectTypeId; displayName: string }> {
    return this.types.map((t) => ({ id: t.id, displayName: t.displayName }))
  }

  /** Detection is a convenience, not a contract — the user can always override. */
  async detectType(dir: string): Promise<ProjectType> {
    for (const type of this.types) {
      if (await type.detect(dir)) return type
    }
    return this.staticType
  }

  // ── registry ────────────────────────────────────────────────────────────

  list(): Project[] {
    return [...this.deps.store.get().projects]
  }

  find(id: string): Project {
    const project = this.deps.store.get().projects.find((p) => p.id === id)
    if (!project) throw new Error(`Unknown project: ${id}`)
    return project
  }

  /** Park a directory: every immediate subdirectory becomes a site. */
  async park(dir: string): Promise<ProjectDescriptor[]> {
    this.deps.store.update((s) => {
      if (!s.settings.parkedDirs.includes(dir)) s.settings.parkedDirs.push(dir)
    })
    const children = readdirSync(dir).filter((name) => {
      if (name.startsWith('.')) return false
      try {
        return statSync(join(dir, name)).isDirectory()
      } catch {
        return false
      }
    })
    const out: ProjectDescriptor[] = []
    for (const name of children) {
      out.push(await this.add(join(dir, name), 'parked'))
    }
    return out
  }

  /** Link a single directory as one site. */
  link(dir: string): Promise<ProjectDescriptor> {
    return this.add(dir, 'linked')
  }

  private async add(dir: string, origin: Project['origin']): Promise<ProjectDescriptor> {
    const existing = this.deps.store.get().projects.find((p) => p.path === dir)
    if (existing) return this.describe(existing)

    const type = await this.detectType(dir)
    const name = basename(dir)
    const tld = this.deps.store.get().settings.tld

    const project: Project = {
      id: randomUUID(),
      name,
      path: dir,
      origin,
      typeId: type.id,
      typeOverridden: false,
      serveModel: type.serveModel,
      frameworkId: null,
      domain: `${name}.${tld}`,
      secure: false,
      port: null,
      startCommandOverride: null,
      runtimeOverride: null,
      createdAt: Date.now()
    }

    // Reverse-proxy sites get their port up front so the vhost is stable from
    // the very first render, not from the first start.
    if (type.serveModel === 'reverse-proxy') {
      project.port = await this.deps.ports.allocate(`project:${project.id}`, type.defaultPort)
    }
    if (type.serveModel === 'fpm') {
      project.frameworkId = (await this.frameworks.detect(dir)).id
    }

    this.deps.store.update((s) => {
      s.projects.push(project)
    })
    await this.writeVhost(project)
    return this.emitChanged(project)
  }

  async forget(id: string): Promise<void> {
    const project = this.find(id)
    const handle = this.deps.processes.findByOwner('project', id)
    if (handle) await this.deps.processes.stop(handle.id)
    this.nginx.remove(project)
    this.deps.ports.release(`project:${id}`)
    this.deps.store.update((s) => {
      s.projects = s.projects.filter((p) => p.id !== id)
    })
  }

  async update(
    id: string,
    patch: {
      typeId?: ProjectTypeId
      startCommandOverride?: string | null
      runtimeOverride?: { runtime: RuntimeId; version: string } | null
      secure?: boolean
    }
  ): Promise<ProjectDescriptor> {
    const project = this.find(id)

    if (patch.typeId && patch.typeId !== project.typeId) {
      const type = this.typeById(patch.typeId)
      project.typeId = type.id
      project.typeOverridden = true
      project.serveModel = type.serveModel
      project.frameworkId =
        type.serveModel === 'fpm' ? (await this.frameworks.detect(project.path)).id : null
      if (type.serveModel === 'reverse-proxy' && !project.port) {
        project.port = await this.deps.ports.allocate(`project:${id}`, type.defaultPort)
      }
    }
    if (patch.startCommandOverride !== undefined) {
      project.startCommandOverride = patch.startCommandOverride
    }
    if (patch.runtimeOverride !== undefined) {
      project.runtimeOverride = patch.runtimeOverride
      if (patch.runtimeOverride) {
        this.deps.runtimes.resolver.setOverride(
          project.path,
          patch.runtimeOverride.runtime,
          patch.runtimeOverride.version
        )
      }
    }
    if (patch.secure !== undefined) project.secure = patch.secure

    this.deps.store.update((s) => {
      const idx = s.projects.findIndex((p) => p.id === id)
      if (idx >= 0) s.projects[idx] = project
    })
    await this.writeVhost(project)
    return this.emitChanged(project)
  }

  // ── serving ─────────────────────────────────────────────────────────────

  private async writeVhost(project: Project): Promise<void> {
    const ctx: VhostContext = { project, root: project.path }

    if (project.serveModel === 'fpm') {
      const framework =
        this.frameworks.get(project.frameworkId ?? '') ?? (await this.frameworks.detect(project.path))
      const docroot = framework.docroot(project.path)
      ctx.root = docroot ? join(project.path, docroot) : project.path
      ctx.frontController = framework.frontController(project.path)
      ctx.rewrites = framework.rewrites(project.path)

      const pinned =
        (await framework.isolatedPhpVersion?.(project.path)) ??
        (await this.deps.php.activeVersion(project.path)) ??
        (await this.deps.php.installedVersions())[0]
      if (!pinned) throw new Error('No PHP version installed — install one before serving PHP sites')
      ctx.fpmSocket = this.deps.php.fpmSocket(pinned)
    }

    if (project.serveModel === 'reverse-proxy') {
      ctx.proxyPort =
        project.port ?? (await this.deps.ports.allocate(`project:${project.id}`, 3000))
    }

    if (project.serveModel === 'static') {
      const docroot = this.staticType.docroot(project.path)
      ctx.root = docroot ? join(project.path, docroot) : project.path
    }

    if (project.secure) {
      const certFile = join(paths.certs, `${project.domain}.pem`)
      const keyFile = join(paths.certs, `${project.domain}-key.pem`)
      if (existsSync(certFile) && existsSync(keyFile)) ctx.cert = { certFile, keyFile }
    }

    this.nginx.write(ctx)
  }

  /** Start a project's dev server. FPM/static sites have nothing to start. */
  async start(id: string): Promise<ProjectDescriptor> {
    const project = this.find(id)
    if (project.serveModel !== 'reverse-proxy') {
      await this.writeVhost(project)
      return this.emitChanged(project)
    }

    const existing = this.deps.processes.findByOwner('project', id)
    if (existing) return this.describe(project)

    const command = await this.resolveStartCommand(project)
    if (!command) {
      throw new Error(`No start command for ${project.name} — set one in the project settings`)
    }

    const resolved = await this.resolveRuntime(project)
    const [bin, ...args] = command.split(/\s+/)
    if (!bin) throw new Error(`Empty start command for ${project.name}`)

    // The resolved runtime's bin dir goes on PATH so `npm`/`npx` resolve to our
    // managed toolchain rather than whatever the user's shell would pick.
    const env: Record<string, string> = {}
    if (resolved?.binary) {
      env.PATH = `${join(resolved.binary, '..')}:${process.env.PATH ?? ''}`
    }

    const handle = await this.deps.processes.spawn({
      owner: { kind: 'project', id },
      label: project.domain,
      command: bin,
      args,
      cwd: project.path,
      env,
      portEnvVar: 'PORT',
      preferredPort: project.port ?? 3000
    })

    if (handle.port && handle.port !== project.port) {
      project.port = handle.port
      this.deps.store.update((s) => {
        const idx = s.projects.findIndex((p) => p.id === id)
        if (idx >= 0) s.projects[idx] = project
      })
    }
    await this.writeVhost(project)
    return this.emitChanged(project)
  }

  async stop(id: string): Promise<ProjectDescriptor> {
    const handle = this.deps.processes.findByOwner('project', id)
    if (handle) await this.deps.processes.stop(handle.id)
    return this.emitChanged(this.find(id))
  }

  async resolveStartCommand(project: Project): Promise<string | null> {
    if (project.startCommandOverride) return project.startCommandOverride
    return this.typeById(project.typeId).startCommand(project.path)
  }

  async resolveRuntime(project: Project): Promise<ResolvedVersion | null> {
    const ref =
      project.runtimeOverride ?? (await this.typeById(project.typeId).resolveRuntime(project.path))
    if (!ref || !this.deps.runtimes.has(ref.runtime)) return null
    return this.deps.runtimes.resolve(ref.runtime, project.path)
  }

  // ── descriptors ─────────────────────────────────────────────────────────

  async describe(project: Project): Promise<ProjectDescriptor> {
    const handle = this.deps.processes.findByOwner('project', project.id)
    return {
      ...project,
      resolvedRuntime: await this.resolveRuntime(project).catch(() => null),
      resolvedStartCommand: await this.resolveStartCommand(project).catch(() => null),
      processId: handle?.id ?? null,
      running: handle?.state === 'running',
      url: `${project.secure ? 'https' : 'http'}://${project.domain}`
    }
  }

  async describeAll(): Promise<ProjectDescriptor[]> {
    return Promise.all(this.list().map((p) => this.describe(p)))
  }

  private async emitChanged(project: Project): Promise<ProjectDescriptor> {
    const descriptor = await this.describe(project)
    this.emit('changed', descriptor)
    return descriptor
  }
}

export { NginxManager }

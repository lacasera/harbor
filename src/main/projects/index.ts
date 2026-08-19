import { EventEmitter } from 'node:events'
import { existsSync, readdirSync, rmSync, statSync } from 'node:fs'
import { basename, join } from 'node:path'
import { randomUUID } from 'node:crypto'
import type {
  Project,
  ProjectDescriptor,
  ProjectType,
  ProjectTypeId
} from '../../shared/project.js'
import type { LogSource } from '../../shared/logs.js'
import type { ResolvedVersion, RuntimeId } from '../../shared/runtime.js'
import type { ConfigStore } from '../core/config-store.js'
import type { ProcessManager } from '../core/process-manager.js'
import type { LogAggregator } from '../core/log-aggregator.js'
import type { PortAllocator } from '../core/port-allocator.js'
import type { RuntimeManager } from '../runtimes/index.js'
import type { PhpRuntime } from '../runtimes/php.js'
import type { PhpFpmManager } from '../runtimes/php-fpm.js'
import type { NativeBackend } from '../backends/native-backend.js'
import type { PrivilegedHelper } from '../core/privileged-helper.js'
import { paths } from '../core/paths.js'
import { binDirOf, resolveBinary } from '../core/resolve-binary.js'
import { matchVersion } from '../runtimes/version-resolver.js'
import { NginxManager, type VhostContext } from './nginx-manager.js'
import type { TlsManager } from './tls.js'
import { PhpFrameworkRegistry, createPhpFrameworkRegistry } from './php-frameworks/index.js'
import { PhpProjectType } from './types/php.js'
import { NodeServerProjectType } from './types/node-server.js'
import { StaticProjectType } from './types/static.js'

export interface ProjectManagerDeps {
  store: ConfigStore
  processes: ProcessManager
  ports: PortAllocator
  runtimes: RuntimeManager
  logs: LogAggregator
  php: PhpRuntime
  fpm: PhpFpmManager
  native: NativeBackend
  privileged: PrivilegedHelper
  tls: TlsManager
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
      serviceIds: [],
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

  /**
   * Re-render every project's vhost, then reload nginx once if the result is
   * valid. Failures are collected rather than thrown: one broken project must
   * not stop the other sites from being served.
   */
  async rewriteAllVhosts(): Promise<{
    written: number
    removed: number
    failed: Array<[string, string]>
  }> {
    const failed: Array<[string, string]> = []
    let written = 0

    const expected = new Set<string>()
    for (const project of this.list()) {
      expected.add(`${project.domain}.conf`)
      try {
        await this.writeVhost(project)
        await this.attachLogs(project)
        written++
      } catch (err) {
        failed.push([project.name, (err as Error).message])
      }
    }

    // Every fpm site needs a pool listening before nginx can reach it.
    for (const version of new Set(
      await Promise.all(
        this.list()
          .filter((p) => p.serveModel === 'fpm')
          .map((p) => this.resolvePhpVersion(p).catch(() => null))
      )
    )) {
      if (version) await this.deps.fpm.start(version).catch(() => undefined)
    }

    // Harbor owns this directory outright. An orphan left by a forgotten
    // project — or by an older build — is still loaded by nginx, and one
    // malformed file makes `nginx -t` fail for every site at once.
    let removed = 0
    if (existsSync(paths.vhosts)) {
      for (const file of readdirSync(paths.vhosts)) {
        if (!file.endsWith('.conf') || expected.has(file)) continue
        rmSync(join(paths.vhosts, file), { force: true })
        removed++
      }
    }

    if ((written || removed) && this.nginx.isConnected()) {
      const check = await this.nginx.test()
      if (check.ok) await this.nginx.reload().catch(() => undefined)
    }
    return { written, removed, failed }
  }

  /**
   * Re-home every project onto a new TLD.
   *
   * The domain is stored per project, so changing the setting alone left every
   * site on the old name with a vhost and certificate to match — the control
   * appeared to work and changed nothing. This renames them, drops the stale
   * vhosts, and re-issues certificates for secured sites.
   *
   * The caller still has to point DNS at the new TLD: that needs a root-written
   * /etc/resolver file.
   */
  async changeTld(next: string): Promise<{ renamed: Array<[string, string]>; failed: Array<[string, string]> }> {
    const renamed: Array<[string, string]> = []
    const failed: Array<[string, string]> = []

    for (const project of this.list()) {
      const from = project.domain
      const to = `${project.name}.${next}`
      if (from === to) continue

      try {
        // Remove the old vhost before the domain changes, or its filename —
        // derived from the domain — becomes unreachable and it lingers forever,
        // still claiming that server_name.
        this.nginx.remove(project)
        project.domain = to

        this.deps.store.update((st) => {
          const idx = st.projects.findIndex((p) => p.id === project.id)
          if (idx >= 0) st.projects[idx] = project
        })

        await this.writeVhost(project)
        // Without this the renderer keeps showing the old domain until the
        // app is relaunched — the rename looked like it had not happened.
        await this.emitChanged(project)
        renamed.push([from, to])
      } catch (err) {
        failed.push([to, (err as Error).message])
      }
    }

    if (renamed.length) await this.rewriteAllVhosts().catch(() => undefined)
    return { renamed, failed }
  }

  async forget(id: string): Promise<void> {
    const project = this.find(id)
    const handle = this.deps.processes.findByOwner('project', id)
    if (handle) await this.deps.processes.stop(handle.id)
    this.deps.logs.detach(id)
    this.nginx.remove(project)
    this.deps.ports.release(`project:${id}`)
    this.emit('forgotten', id)
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
      serviceIds?: string[]
      redetectType?: boolean
    }
  ): Promise<ProjectDescriptor> {
    const project = this.find(id)

    // Detection is a convenience, not a contract — but a wrong override has to
    // be undoable, or the project is stuck serving the wrong model forever.
    if (patch.redetectType) {
      const detected = await this.detectType(project.path)
      project.typeId = detected.id
      project.typeOverridden = false
      project.serveModel = detected.serveModel
      project.frameworkId =
        detected.serveModel === 'fpm' ? (await this.frameworks.detect(project.path)).id : null
      if (detected.serveModel === 'reverse-proxy' && !project.port) {
        project.port = await this.deps.ports.allocate(`project:${id}`, detected.defaultPort)
      }
    }

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
    if (patch.serviceIds !== undefined) project.serviceIds = patch.serviceIds

    this.deps.store.update((s) => {
      const idx = s.projects.findIndex((p) => p.id === id)
      if (idx >= 0) s.projects[idx] = project
    })
    await this.writeVhost(project)
    return this.emitChanged(project)
  }

  // ── serving ─────────────────────────────────────────────────────────────

  private async writeVhost(project: Project): Promise<void> {
    const { httpPort, httpsPort } = this.deps.store.get().settings
    const ctx: VhostContext = { project, root: project.path, httpPort, httpsPort }

    if (project.serveModel === 'fpm') {
      const framework =
        this.frameworks.get(project.frameworkId ?? '') ?? (await this.frameworks.detect(project.path))
      const docroot = framework.docroot(project.path)
      ctx.root = docroot ? join(project.path, docroot) : project.path
      ctx.frontController = framework.frontController(project.path)
      ctx.rewrites = framework.rewrites(project.path)

      ctx.fpmSocket = this.deps.php.fpmSocket(await this.resolvePhpVersion(project, framework))
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
      // Issue on demand. Previously this only picked up a cert that happened to
      // exist already, so enabling TLS silently kept serving plain HTTP.
      try {
        ctx.cert = await this.deps.tls.certify(project.domain)
      } catch (err) {
        const certFile = join(paths.certs, `${project.domain}.pem`)
        const keyFile = join(paths.certs, `${project.domain}-key.pem`)
        if (existsSync(certFile) && existsSync(keyFile)) {
          ctx.cert = { certFile, keyFile }
        } else {
          throw new Error(
            `Cannot secure ${project.domain}: ${(err as Error).message}. ` +
              `Install mkcert and its CA from Settings first.`
          )
        }
      }
    }

    this.nginx.write(ctx)
  }

  /**
   * The PHP version this site should be served with, resolved to one that is
   * actually installed. A pin of `^8.3` against an installed 8.4 must resolve
   * to 8.4 — pointing the vhost at a pool for a version that isn't there is
   * how a site 502s with nothing obviously wrong.
   */
  async resolvePhpVersion(
    project: Project,
    framework?: { isolatedPhpVersion?: (dir: string) => Promise<string | null> }
  ): Promise<string> {
    const installed = await this.deps.php.installedVersions()
    if (!installed.length) {
      throw new Error(
        'No PHP is installed. Install one with: brew install php@8.4'
      )
    }

    const requested =
      (await framework?.isolatedPhpVersion?.(project.path)) ??
      (await this.deps.php.activeVersion(project.path))

    if (!requested) return installed[0] as string
    return matchVersion(requested, installed) ?? (installed[0] as string)
  }

  /** Make sure the pool a site's vhost points at is actually listening. */
  async ensureFpmFor(project: Project): Promise<string | null> {
    if (project.serveModel !== 'fpm') return null
    const framework =
      this.frameworks.get(project.frameworkId ?? '') ?? (await this.frameworks.detect(project.path))
    const version = await this.resolvePhpVersion(project, framework)
    await this.deps.fpm.start(version)
    return version
  }

  /**
   * Everything worth tailing for a project: the nginx logs Harbor writes for
   * its domain, whatever the project type declares, and — for fpm sites — what
   * the framework driver declares. Merged here so no single layer has to know
   * about all three.
   */
  async logSourcesFor(project: Project): Promise<LogSource[]> {
    const sources: LogSource[] = [
      {
        kind: 'dir',
        path: paths.logs,
        // Only this site's access/error logs, not every project's.
        match: `^${project.domain.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\.(access|error)\\.log$`,
        label: 'nginx'
      }
    ]

    try {
      sources.push(...(this.typeById(project.typeId).logSources?.(project.path) ?? []))
    } catch {
      /* an unknown type should not stop the nginx logs being tailed */
    }

    if (project.serveModel === 'fpm') {
      const framework =
        this.frameworks.get(project.frameworkId ?? '') ??
        (await this.frameworks.detect(project.path).catch(() => null))
      sources.push(...(framework?.logSources?.(project.path) ?? []))
    }

    return sources
  }

  /** Begin tailing a project's logs, tagged with the project id. */
  async attachLogs(project: Project): Promise<void> {
    this.deps.logs.attach(project.id, await this.logSourcesFor(project))
  }

  /** Start a project's dev server. FPM/static sites have nothing to start. */
  async start(id: string): Promise<ProjectDescriptor> {
    const project = this.find(id)
    if (project.serveModel !== 'reverse-proxy') {
      // Nothing to spawn for the site itself, but an fpm site is not servable
      // until its pool is up.
      await this.ensureFpmFor(project)
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
    const [rawBin, ...args] = command.split(/\s+/)
    if (!rawBin) throw new Error(`Empty start command for ${project.name}`)

    // The resolved runtime's bin dir goes first, so a project pinned to a
    // managed toolchain uses that npm rather than whichever is on PATH.
    const runtimeBins = binDirOf(resolved?.binary ?? null)
    const env: Record<string, string> = {}
    if (runtimeBins.length) {
      env.PATH = `${runtimeBins.join(':')}:${process.env.PATH ?? ''}`
    }

    const bin = resolveBinary(rawBin, runtimeBins, { ...process.env, ...env })
    if (!bin) {
      throw new Error(
        `Cannot find "${rawBin}" for ${project.name}. ` +
          `Install the runtime it needs, or set an absolute start command in the project settings.`
      )
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
    const serving = await this.servingState(project, handle?.state === 'running', handle?.pid ?? null)
    return {
      ...project,
      // Projects persisted before this field existed have no array.
      serviceIds: project.serviceIds ?? [],
      resolvedRuntime: await this.resolveRuntime(project).catch(() => null),
      resolvedStartCommand: await this.resolveStartCommand(project).catch(() => null),
      processId: handle?.id ?? null,
      running: handle?.state === 'running',
      served: serving.served,
      servedBy: serving.by,
      servedProblem: serving.problem,
      url: this.urlFor(project)
    }
  }

  /**
   * "Is this site up?" is a different question per serve model, and answering
   * it with process state was wrong for two of the three: an fpm or static site
   * has no process of its own and read as permanently idle while nginx served
   * it perfectly well.
   */
  private async servingState(
    project: Project,
    processRunning: boolean,
    pid: number | null
  ): Promise<{ served: boolean; by: string | null; problem: string | null }> {
    if (project.serveModel === 'reverse-proxy') {
      return processRunning
        ? { served: true, by: pid ? `dev server · pid ${pid}` : 'dev server', problem: null }
        : { served: false, by: null, problem: 'dev server is not running' }
    }

    const nginxUp = await this.nginx.isRunningCached()
    if (!nginxUp) return { served: false, by: null, problem: 'nginx is not running' }
    if (!this.nginx.isConnected()) {
      return { served: false, by: null, problem: "nginx isn't reading Harbor's vhosts" }
    }
    if (await this.nginx.workersCannotReadProjects()) {
      return {
        served: false,
        by: null,
        problem:
          'nginx workers run as "nobody" and cannot read your projects — restart nginx from Settings'
      }
    }

    if (project.serveModel === 'static') {
      return { served: true, by: 'nginx · static files', problem: null }
    }

    // fpm: nginx can only reach the site if the pool it points at is listening.
    try {
      const version = await this.resolvePhpVersion(project)
      if (!this.deps.fpm.isRunning(version)) {
        return { served: false, by: null, problem: `PHP-FPM ${version} pool is not running` }
      }
      return { served: true, by: `php-fpm ${version}`, problem: null }
    } catch (err) {
      return { served: false, by: null, problem: (err as Error).message }
    }
  }

  /** Include the port unless it's the scheme default, so links stay clickable. */
  private urlFor(project: Project): string {
    const { httpPort, httpsPort } = this.deps.store.get().settings
    const scheme = project.secure ? 'https' : 'http'
    const port = project.secure ? httpsPort : httpPort
    const suffix = (scheme === 'https' && port === 443) || (scheme === 'http' && port === 80)
      ? ''
      : `:${port}`
    return `${scheme}://${project.domain}${suffix}`
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

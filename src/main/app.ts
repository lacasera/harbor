import { ConfigStore } from './core/config-store.js'
import { PortAllocator } from './core/port-allocator.js'
import { ProcessManager } from './core/process-manager.js'
import { LogAggregator } from './core/log-aggregator.js'
import { PrivilegedHelper } from './core/privileged-helper.js'
import { NativeBackend } from './backends/native-backend.js'
import { DockerBackend } from './backends/docker-backend.js'
import { ServiceCatalogue } from './services/registry.js'
import { ServiceInstances } from './services/instances.js'
import { registerServices } from './services/index.js'
import { RuntimeManager, registerRuntimes } from './runtimes/index.js'
import { PhpRuntime } from './runtimes/php.js'
import { PhpFpmManager } from './runtimes/php-fpm.js'
import { ProjectManager } from './projects/index.js'
import { DnsmasqManager } from './projects/dnsmasq.js'
import { TlsManager } from './projects/tls.js'
import { CodeIntelligence, createCodeIntelligence } from './intelligence/index.js'
import { MACHINE_OWNER } from '../shared/service.js'
import { ensureDirs, HARBOR_HOME } from './core/paths.js'

/**
 * Composition root. Every subsystem is constructed exactly once here and passed
 * down explicitly — no singletons, no module-level state, so the IPC layer has
 * one object to talk to and tests can build a container with fakes.
 */
export class HarborApp {
  readonly store: ConfigStore
  readonly ports: PortAllocator
  readonly processes: ProcessManager
  readonly logs: LogAggregator
  readonly privileged: PrivilegedHelper
  readonly native: NativeBackend
  readonly docker: DockerBackend
  readonly catalogue: ServiceCatalogue
  readonly services: ServiceInstances
  readonly runtimes: RuntimeManager
  readonly projects: ProjectManager
  readonly fpm: PhpFpmManager
  readonly dns: DnsmasqManager
  readonly tls: TlsManager
  readonly intelligence: CodeIntelligence

  constructor() {
    ensureDirs()

    this.store = new ConfigStore()
    this.ports = new PortAllocator(this.store)
    this.processes = new ProcessManager(this.ports)
    this.logs = new LogAggregator(this.processes)
    this.privileged = new PrivilegedHelper()

    this.native = new NativeBackend(this.processes)
    this.docker = new DockerBackend(this.processes)

    this.catalogue = new ServiceCatalogue()
    registerServices(this.catalogue, {
      native: this.native,
      docker: this.docker,
      processes: this.processes
    })

    this.runtimes = new RuntimeManager(this.store)
    registerRuntimes(this.runtimes, { native: this.native })
    const php = this.runtimes.get('php') as PhpRuntime
    this.fpm = new PhpFpmManager(php, this.processes)

    this.tls = new TlsManager(this.native, this.privileged)

    this.projects = new ProjectManager({
      store: this.store,
      processes: this.processes,
      ports: this.ports,
      runtimes: this.runtimes,
      logs: this.logs,
      php,
      fpm: this.fpm,
      native: this.native,
      privileged: this.privileged,
      tls: this.tls,
      docker: this.docker
    })

    // Built after ProjectManager: an owner's compose project name is stored on
    // its Project, so resolving one means asking the project manager.
    this.services = new ServiceInstances(
      this.catalogue,
      this.store,
      this.logs,
      this.processes,
      this.ports,
      this.docker,
      (owner) => this.projects.composeProjectFor(owner),
      (owner) => this.projects.ownerNameFor(owner)
    )
    this.projects.attachServices(this.services)

    this.dns = new DnsmasqManager(this.native, this.privileged, this.processes)
    this.intelligence = createCodeIntelligence()
    // Stop watching a project's sources once it is no longer managed.
    this.projects.on('forgotten', (id: string) => this.intelligence.unwatch(id))
  }

  async start(): Promise<void> {
    // A previous Harbor that was force-quit leaves its daemons holding ports
    // and sockets; the next launch then fails to bind for no visible reason.
    const reclaimed = await ProcessManager.reclaimOrphans(HARBOR_HOME).catch(() => 0)
    if (reclaimed) {
      this.logs.push('harbor', 'startup', `reclaimed ${reclaimed} orphaned process(es)`)
      await new Promise((r) => setTimeout(r, 500))
    }

    // Instances whose project is gone: a crash between forgetting a project and
    // detaching its stack leaves records nothing can ever reach again.
    const orphans = await this.services
      .reconcile(this.store.get().projects.map((p) => p.id))
      .catch(() => [])
    if (orphans.length) {
      this.logs.push(
        'harbor',
        'startup',
        `detached ${orphans.length} service instance(s) whose project no longer exists`
      )
    }

    this.processes.startUsagePolling()
    this.services.startHealthPolling()
    this.projects.nginx.ensureRootConfig()

    // DNS is unprivileged and useless when not running, so start it rather
    // than making every user click the same button on every launch.
    if (this.dns.isInstalled()) {
      await this.dns.start(this.store.get().settings.tld).catch(() => undefined)
    }

    // Vhosts are otherwise only written on park/update, so a deleted file, a
    // changed TLD or a newly issued certificate would leave nginx serving
    // stale config until the user touched each project. This also brings up a
    // PHP-FPM pool for every fpm site.
    await this.projects.rewriteAllVhosts()

    if (this.store.get().settings.autoStartServices) {
      for (const project of this.store.get().projects) {
        await this.services.startOwner(project.id)
      }
      await this.services.startOwner(MACHINE_OWNER)
    }
  }

  async shutdown(): Promise<void> {
    this.processes.stopUsagePolling()
    this.services.stopHealthPolling()
    this.intelligence.stopAll()
    await this.fpm.stopAll().catch(() => undefined)
    await this.services.stopAll()
    await this.processes.stopAll()
    // Persist synchronously: quitting must not drop the last config change.
    this.store.flush()
  }
}

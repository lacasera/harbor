import { ConfigStore } from './core/config-store.js'
import { PortAllocator } from './core/port-allocator.js'
import { ProcessManager } from './core/process-manager.js'
import { LogAggregator } from './core/log-aggregator.js'
import { Notifier } from './core/notifier.js'
import { PrivilegedHelper } from './core/privileged-helper.js'
import type { PortConflict } from '../shared/process.js'
import { NativeBackend } from './backends/native-backend.js'
import { DockerBackend } from './backends/docker-backend.js'
import { ServiceRegistry } from './services/registry.js'
import { registerServices } from './services/index.js'
import { RuntimeManager, registerRuntimes } from './runtimes/index.js'
import { PhpRuntime } from './runtimes/php.js'
import { PhpFpmManager } from './runtimes/php-fpm.js'
import { ProjectManager } from './projects/index.js'
import { DnsmasqManager } from './projects/dnsmasq.js'
import { TlsManager } from './projects/tls.js'
import { CodeIntelligence, createCodeIntelligence } from './intelligence/index.js'
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
  readonly notifier: Notifier
  readonly privileged: PrivilegedHelper
  readonly native: NativeBackend
  readonly docker: DockerBackend
  readonly services: ServiceRegistry
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
    this.notifier = new Notifier()
    this.privileged = new PrivilegedHelper()

    // A port conflict crashes a process without a spawn error, so it would
    // otherwise vanish into the logs. Surface it: the one that bound the port
    // keeps running, and this tells the user which one lost and why.
    this.processes.on('port-conflict', ({ handle, port }: PortConflict) => {
      const where = port ? `Port ${port} is already in use` : 'Its port is already in use'
      this.notifier.notify({
        level: 'error',
        title: `${handle.label} couldn't start`,
        message: `${where}. The process already holding it keeps running.`,
        source: handle.owner.id
      })
      this.logs.push(handle.owner.id, handle.owner.role ?? 'process', `port conflict: ${where.toLowerCase()}`)
    })

    this.native = new NativeBackend(this.processes)
    this.docker = new DockerBackend(this.processes)

    this.services = new ServiceRegistry(this.store, this.logs, this.processes)
    registerServices(this.services, {
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
      tls: this.tls
    })

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
      await this.services.autoStart()
    }

    // Bring up every companion the user left on "auto" (queue workers,
    // schedulers, Vite, …). Sequential so that when two want the same fixed
    // port the first to bind wins and the rest raise a port-conflict notice.
    await this.projects.autoStartProcesses()
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

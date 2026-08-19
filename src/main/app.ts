import { ConfigStore } from './core/config-store.js'
import { PortAllocator } from './core/port-allocator.js'
import { ProcessManager } from './core/process-manager.js'
import { LogAggregator } from './core/log-aggregator.js'
import { PrivilegedHelper } from './core/privileged-helper.js'
import { NativeBackend } from './backends/native-backend.js'
import { DockerBackend } from './backends/docker-backend.js'
import { ServiceRegistry } from './services/registry.js'
import { registerServices } from './services/index.js'
import { RuntimeManager, registerRuntimes } from './runtimes/index.js'
import { PhpRuntime } from './runtimes/php.js'
import { ProjectManager } from './projects/index.js'
import { DnsmasqManager } from './projects/dnsmasq.js'
import { TlsManager } from './projects/tls.js'
import { CodeIntelligence, createCodeIntelligence } from './intelligence/index.js'
import { ensureDirs } from './core/paths.js'

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
  readonly services: ServiceRegistry
  readonly runtimes: RuntimeManager
  readonly projects: ProjectManager
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

    this.services = new ServiceRegistry(this.store, this.logs)
    registerServices(this.services, {
      native: this.native,
      docker: this.docker,
      processes: this.processes
    })

    this.runtimes = new RuntimeManager(this.store)
    registerRuntimes(this.runtimes, { native: this.native })
    const php = this.runtimes.get('php') as PhpRuntime

    this.tls = new TlsManager(this.native, this.privileged)

    this.projects = new ProjectManager({
      store: this.store,
      processes: this.processes,
      ports: this.ports,
      runtimes: this.runtimes,
      php,
      native: this.native,
      privileged: this.privileged,
      tls: this.tls
    })

    this.dns = new DnsmasqManager(this.native, this.privileged, this.processes)
    this.intelligence = createCodeIntelligence()
  }

  async start(): Promise<void> {
    this.processes.startUsagePolling()
    this.projects.nginx.ensureRootConfig()

    // Vhosts are otherwise only written on park/update, so a deleted file, a
    // changed TLD or a newly issued certificate would leave nginx serving
    // stale config until the user touched each project.
    await this.projects.rewriteAllVhosts()

    if (this.store.get().settings.autoStartServices) {
      await this.services.autoStart()
    }
  }

  async shutdown(): Promise<void> {
    this.processes.stopUsagePolling()
    await this.services.stopAll()
    await this.processes.stopAll()
    // Persist synchronously: quitting must not drop the last config change.
    this.store.flush()
  }
}

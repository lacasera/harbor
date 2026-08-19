import { EventEmitter } from 'node:events'
import type {
  EnvBlock,
  ServiceConfig,
  ServiceDescriptor,
  ServiceDriver,
  ServiceStatus
} from '../../shared/service.js'
import type { JSONSchema } from '../../shared/json-schema.js'
import type { ConfigStore } from '../core/config-store.js'
import type { LogAggregator } from '../core/log-aggregator.js'

/**
 * Holds every ServiceDriver and is the only thing the IPC layer talks to.
 * Adding a service means registering a driver here — there is deliberately no
 * hook for per-service behaviour anywhere above this line.
 */
export class ServiceRegistry extends EventEmitter {
  private readonly drivers = new Map<string, ServiceDriver>()
  private readonly statuses = new Map<string, ServiceStatus>()

  constructor(
    private readonly store: ConfigStore,
    private readonly logs: LogAggregator
  ) {
    super()
  }

  register(driver: ServiceDriver): void {
    this.drivers.set(driver.id, driver)
    // Seed config from the schema defaults on first sight of a driver.
    if (!this.store.get().services[driver.id]) {
      this.store.update((s) => {
        s.services[driver.id] = {
          serviceId: driver.id,
          version: 'latest',
          values: defaultsFor(driver.configSchema),
          autoStart: false
        }
      })
    }
    this.logs.attach(driver.id, driver.logSources)
  }

  get(id: string): ServiceDriver {
    const driver = this.drivers.get(id)
    if (!driver) throw new Error(`Unknown service: ${id}`)
    return driver
  }

  configFor(id: string): ServiceConfig {
    const stored = this.store.get().services[id]
    if (stored) return stored
    const driver = this.get(id)
    return {
      serviceId: id,
      version: 'latest',
      values: defaultsFor(driver.configSchema),
      autoStart: false
    }
  }

  async describeAll(): Promise<ServiceDescriptor[]> {
    return Promise.all([...this.drivers.keys()].map((id) => this.describe(id)))
  }

  async describe(id: string): Promise<ServiceDescriptor> {
    const driver = this.get(id)
    const config = this.configFor(id)
    const installedVersions = await driver.installedVersions().catch(() => [])
    const status = await driver.healthCheck().catch(
      (err: Error): ServiceStatus => ({ health: 'error', ports: [], error: err.message })
    )
    this.statuses.set(id, status)
    return {
      id: driver.id,
      displayName: driver.displayName,
      description: driver.description,
      backend: driver.backend,
      defaultPorts: driver.defaultPorts,
      configSchema: driver.configSchema,
      envKeys: Object.keys(driver.envHints),
      installed: installedVersions.length > 0,
      installedVersions,
      config,
      status
    }
  }

  async install(id: string, version: string): Promise<void> {
    await this.get(id).install(version)
    this.store.update((s) => {
      const existing = s.services[id]
      if (existing) existing.version = version
    })
    this.emitChanged(id)
  }

  async start(id: string): Promise<ServiceDescriptor> {
    const driver = this.get(id)
    await driver.start(this.configFor(id))
    this.logs.attach(id, driver.logSources)
    return this.emitChanged(id)
  }

  async stop(id: string): Promise<ServiceDescriptor> {
    await this.get(id).stop()
    return this.emitChanged(id)
  }

  async updateConfig(id: string, patch: Partial<ServiceConfig>): Promise<ServiceDescriptor> {
    const current = this.configFor(id)
    const next: ServiceConfig = {
      ...current,
      ...patch,
      values: { ...current.values, ...(patch.values ?? {}) }
    }
    this.store.update((s) => {
      s.services[id] = next
    })
    return this.emitChanged(id)
  }

  /**
   * Renders a service's envHints against its LIVE config — the actual bound
   * port and resolved credentials, not schema defaults. This is the whole
   * env-export feature; there is no per-service export code anywhere.
   */
  async envBlock(id: string): Promise<EnvBlock> {
    const driver = this.get(id)
    const config = this.configFor(id)
    const status = this.statuses.get(id) ?? (await driver.healthCheck().catch(() => null))
    const scope: Record<string, unknown> = {
      ...config.values,
      version: config.version,
      host: '127.0.0.1',
      port: status?.ports[0] ?? config.values.port ?? driver.defaultPorts[0]
    }
    return {
      serviceId: id,
      displayName: driver.displayName,
      vars: Object.entries(driver.envHints).map(([key, template]) => ({
        key,
        value: interpolate(template, scope)
      }))
    }
  }

  async envBlocks(ids: string[]): Promise<EnvBlock[]> {
    return Promise.all(ids.map((id) => this.envBlock(id)))
  }

  async autoStart(): Promise<void> {
    for (const id of this.drivers.keys()) {
      if (this.configFor(id).autoStart) {
        await this.start(id).catch(() => undefined)
      }
    }
  }

  async stopAll(): Promise<void> {
    for (const driver of this.drivers.values()) {
      await driver.stop().catch(() => undefined)
    }
  }

  private async emitChanged(id: string): Promise<ServiceDescriptor> {
    const descriptor = await this.describe(id)
    this.emit('changed', descriptor)
    return descriptor
  }
}

/** `${key}` interpolation against the live config scope. */
export function interpolate(template: string, scope: Record<string, unknown>): string {
  return template.replace(/\$\{(\w+)\}/g, (_m, key: string) => {
    const value = scope[key]
    return value === undefined || value === null ? '' : String(value)
  })
}

export function defaultsFor(schema: JSONSchema): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const [key, prop] of Object.entries(schema.properties ?? {})) {
    if (prop.default !== undefined) out[key] = prop.default
  }
  return out
}

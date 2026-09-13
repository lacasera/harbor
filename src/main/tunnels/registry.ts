import type { TunnelProviderId } from '../../shared/tunnel.js'
import type { TunnelDriver } from './types.js'

/**
 * The tunnel providers, by id. A lookup table and nothing else — mirrors
 * `ServiceCatalogue`, so adding a provider is "implement `TunnelDriver` and
 * register it" with no other change.
 */
export class TunnelProviders {
  private readonly drivers = new Map<TunnelProviderId, TunnelDriver>()

  register(driver: TunnelDriver): void {
    this.drivers.set(driver.id, driver)
  }

  has(id: TunnelProviderId): boolean {
    return this.drivers.has(id)
  }

  get(id: TunnelProviderId): TunnelDriver {
    const driver = this.drivers.get(id)
    if (!driver) throw new Error(`Unknown tunnel provider: ${id}`)
    return driver
  }

  all(): TunnelDriver[] {
    return [...this.drivers.values()]
  }
}

import type {
  ResolvedVersion,
  RuntimeDescriptor,
  RuntimeDriver,
  RuntimeId
} from '../../shared/runtime.js'
import type { ConfigStore } from '../core/config-store.js'
import type { NativeBackend } from '../backends/native-backend.js'
import { VersionResolver } from './version-resolver.js'
import { NodeRuntime } from './node.js'
import { BunRuntime } from './bun.js'
import { DenoRuntime } from './deno.js'
import { PhpRuntime } from './php.js'

export class RuntimeManager {
  private readonly drivers = new Map<RuntimeId, RuntimeDriver>()
  readonly resolver: VersionResolver

  constructor(private readonly store: ConfigStore) {
    this.resolver = new VersionResolver(store)
  }

  register(driver: RuntimeDriver): void {
    this.drivers.set(driver.id, driver)
  }

  get(id: RuntimeId): RuntimeDriver {
    const driver = this.drivers.get(id)
    if (!driver) throw new Error(`Unknown runtime: ${id}`)
    return driver
  }

  has(id: RuntimeId): boolean {
    return this.drivers.has(id)
  }

  async describeAll(): Promise<RuntimeDescriptor[]> {
    return Promise.all(
      [...this.drivers.values()].map(async (driver) => ({
        id: driver.id,
        displayName: driver.displayName,
        installedVersions: await driver.installedVersions().catch(() => []),
        defaultVersion: this.store.get().runtimeDefaults[driver.id] ?? null
      }))
    )
  }

  resolve(id: RuntimeId, projectPath: string): Promise<ResolvedVersion> {
    return this.resolver.resolve(this.get(id), projectPath)
  }
}

export function registerRuntimes(manager: RuntimeManager, deps: { native: NativeBackend }): void {
  manager.register(new NodeRuntime())
  manager.register(new BunRuntime())
  manager.register(new DenoRuntime())
  manager.register(new PhpRuntime(deps.native))
}

export { VersionResolver }

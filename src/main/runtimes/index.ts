import type {
  ResolvedVersion,
  UpdateInfo,
  RuntimeConfigFile,
  RuntimeDescriptor,
  RuntimeDriver,
  RuntimeId
} from '../../shared/runtime.js'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import type { ConfigStore } from '../core/config-store.js'
import type { NativeBackend } from '../backends/native-backend.js'
import { VersionResolver } from './version-resolver.js'
import { NodeRuntime } from './node.js'
import { BunRuntime } from './bun.js'
import { DenoRuntime } from './deno.js'
import { PhpRuntime } from './php.js'

/** How long an update answer is reused. Releases do not appear by the minute. */
const UPDATE_TTL_MS = 3 * 60 * 60 * 1000
/** A failed check is retried much sooner than a successful one. */
const FAILED_TTL_MS = 5 * 60 * 1000

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
        defaultVersion: this.store.get().runtimeDefaults[driver.id] ?? null,
        configurable: typeof driver.configFiles === 'function'
      }))
    )
  }

  resolve(id: RuntimeId, projectPath: string): Promise<ResolvedVersion> {
    return this.resolver.resolve(this.get(id), projectPath)
  }

  /**
   * Update checks, cached.
   *
   * Every one of these is a network call or a Homebrew invocation — `brew
   * outdated` alone takes several seconds — and the Runtimes page would
   * otherwise fire the lot on every mount. Refreshed on demand instead.
   */
  private readonly updateCache = new Map<string, { info: UpdateInfo; at: number }>()

  async checkUpdates(options: { force?: boolean } = {}): Promise<Record<string, UpdateInfo>> {
    const out: Record<string, UpdateInfo> = {}
    for (const driver of this.drivers.values()) {
      if (!driver.checkUpdate) continue
      for (const version of await driver.installedVersions().catch(() => [])) {
        const key = `${driver.id}#${version}`
        const cached = this.updateCache.get(key)
        if (!options.force && cached && Date.now() - cached.at < UPDATE_TTL_MS) {
          out[key] = cached.info
          continue
        }
        const info = await driver.checkUpdate(version).catch(
          (err: Error): UpdateInfo => ({
            current: version,
            latest: null,
            available: false,
            major: false,
            action: 'Check for updates',
            error: err.message
          })
        )
        // A failed check is cached too, briefly, so a machine with no network
        // does not retry on every render — but not for the full period, so it
        // recovers on its own once the network comes back.
        this.updateCache.set(key, { info, at: info.latest === null ? Date.now() - UPDATE_TTL_MS + FAILED_TTL_MS : Date.now() })
        out[key] = info
      }
    }
    return out
  }

  /**
   * Apply an update, preserving what the user chose.
   *
   * A side-by-side runtime that was the default must stay the default, or
   * updating silently moves every project that relied on it back onto an older
   * version — the opposite of what the button says it does.
   */
  async update(id: RuntimeId, version: string): Promise<string> {
    const driver = this.get(id)
    if (!driver.update) throw new Error(`${id} cannot be updated from Harbor`)
    const wasDefault = this.store.get().runtimeDefaults[id] === version

    const now = await driver.update(version)
    if (wasDefault && now !== version) {
      this.store.update((s) => {
        s.runtimeDefaults[id] = now
      })
    }
    this.updateCache.delete(`${id}#${version}`)
    return now
  }

  /** Editable configuration for a version, with whatever is on disk. */
  configFiles(id: RuntimeId, version: string): RuntimeConfigFile[] {
    return (this.get(id).configFiles?.(version) ?? []).map((spec) => {
      const exists = existsSync(spec.path)
      return {
        ...spec,
        exists,
        content: exists ? readFileSync(spec.path, 'utf8') : ''
      }
    })
  }

  /**
   * Write one of the files the driver declared.
   *
   * Resolved from `id`, never from a path the caller supplies. The renderer is
   * a sandboxed presentation layer with no filesystem access; accepting a path
   * from it would be handing back the filesystem, and "write this file" is the
   * most useful primitive an attacker could ask for.
   */
  writeConfigFile(id: RuntimeId, version: string, fileId: string, content: string): string {
    const spec = (this.get(id).configFiles?.(version) ?? []).find((f) => f.id === fileId)
    if (!spec) throw new Error(`${id} ${version} has no config file "${fileId}"`)
    mkdirSync(dirname(spec.path), { recursive: true })
    writeFileSync(spec.path, content.endsWith('\n') ? content : `${content}\n`, 'utf8')
    return spec.path
  }
}

export function registerRuntimes(manager: RuntimeManager, deps: { native: NativeBackend }): void {
  manager.register(new NodeRuntime())
  manager.register(new BunRuntime())
  manager.register(new DenoRuntime())
  manager.register(new PhpRuntime(deps.native))
}

export { VersionResolver }

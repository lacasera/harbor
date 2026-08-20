import type {
  ContainerRuntimeDescriptor,
  ContainerRuntimeId
} from '../../shared/container-runtime.js'
import { AUTO_RUNTIME } from '../../shared/container-runtime.js'
import type { ConfigStore } from '../core/config-store.js'
import { CONTAINER_RUNTIMES } from './drivers.js'
import type { ContainerInvocation, ContainerRuntimeDriver } from './types.js'

/**
 * Which runtime to use, given a preference and what was found.
 *
 * Pulled out as a function because the rule is the whole feature and it is
 * worth testing without a Docker daemon: an explicit choice is honoured even
 * when it is not running — the user is then told to start it, rather than
 * having their containers quietly created on a different daemon — while `auto`
 * prefers one that is up, and falls back to one that is merely installed so the
 * advice can be "start it" rather than "install something".
 */
export function pickRuntime<T extends { id: ContainerRuntimeId }>(
  preference: ContainerRuntimeId,
  drivers: T[],
  detected: Map<ContainerRuntimeId, { installed: boolean; running: boolean }>
): T | null {
  if (preference !== AUTO_RUNTIME) return drivers.find((d) => d.id === preference) ?? null
  return (
    drivers.find((d) => detected.get(d.id)?.running) ??
    drivers.find((d) => detected.get(d.id)?.installed) ??
    null
  )
}

/** Detection shells out several times; the answer does not change by the second. */
const DETECT_TTL_MS = 30_000

interface Detected {
  installed: boolean
  running: boolean
  version: string | null
  detail?: string
}

/**
 * Which container runtime Harbor uses, and what it takes to reach it.
 *
 * Adding one is a driver in `drivers.ts` and a line in `CONTAINER_RUNTIMES` —
 * the backend, the settings screen and the diagnostics all read from here and
 * none of them knows what Docker Desktop or Podman is.
 */
export class ContainerRuntimes {
  private readonly drivers = new Map<ContainerRuntimeId, ContainerRuntimeDriver>()
  private cache: { at: number; results: Map<ContainerRuntimeId, Detected> } | null = null

  constructor(private readonly store: ConfigStore) {
    for (const driver of CONTAINER_RUNTIMES) this.drivers.set(driver.id, driver)
  }

  get(id: ContainerRuntimeId): ContainerRuntimeDriver {
    const driver = this.drivers.get(id)
    if (!driver) throw new Error(`Unknown container runtime: ${id}`)
    return driver
  }

  private async detectAll(force = false): Promise<Map<ContainerRuntimeId, Detected>> {
    if (!force && this.cache && Date.now() - this.cache.at < DETECT_TTL_MS) {
      return this.cache.results
    }
    const results = new Map<ContainerRuntimeId, Detected>()
    await Promise.all(
      [...this.drivers.values()].map(async (driver) => {
        const found = await driver.detect().catch(() => ({ installed: false, version: null }))
        // Only ask a runtime that is there whether it is running; probing an
        // absent one just waits for a command that will never resolve.
        const running = found.installed ? await driver.running().catch(() => false) : false
        results.set(driver.id, { ...found, running })
      })
    )
    this.cache = { at: Date.now(), results }
    return results
  }

  /** The user's choice, or `auto`. */
  preference(): ContainerRuntimeId {
    return this.store.get().settings.containerRuntime ?? AUTO_RUNTIME
  }

  select(id: ContainerRuntimeId): void {
    if (id !== AUTO_RUNTIME) this.get(id)
    this.store.update((s) => {
      s.settings.containerRuntime = id
    })
    this.cache = null
  }

  /**
   * The runtime to use.
   *
   * An explicit choice is honoured even when it is not running — the user is
   * then told to start it, rather than having their containers quietly created
   * somewhere else. `auto` prefers one that is actually up, and falls back to
   * one that is merely installed so the message can be "start it" rather than
   * "install something".
   */
  async resolve(force = false): Promise<ContainerRuntimeDriver | null> {
    return pickRuntime(this.preference(), [...this.drivers.values()], await this.detectAll(force))
  }

  /** How to invoke the resolved runtime, or null when there is none. */
  async invocation(): Promise<ContainerInvocation | null> {
    const driver = await this.resolve()
    return driver ? driver.invocation() : null
  }

  async describeAll(force = false): Promise<ContainerRuntimeDescriptor[]> {
    const detected = await this.detectAll(force)
    const active = await this.resolve()
    return [...this.drivers.values()].map((driver) => {
      const found = detected.get(driver.id)
      return {
        id: driver.id,
        displayName: driver.displayName,
        description: driver.description,
        installed: found?.installed ?? false,
        running: found?.running ?? false,
        version: found?.version ?? null,
        detail: !found?.installed
          ? 'not installed'
          : found.running
            ? `running${found.version ? ` · ${found.version}` : ''}`
            : 'installed, not running',
        install: driver.install,
        startable: typeof driver.start === 'function',
        selected: active?.id === driver.id
      }
    })
  }

  /** Start a runtime's daemon, when it is one Harbor can start. */
  async start(id: ContainerRuntimeId): Promise<void> {
    const driver = this.get(id)
    if (!driver.start) {
      throw new Error(`${driver.displayName} has to be started from the application itself`)
    }
    await driver.start()
    this.cache = null
  }

  /** Why containers are unavailable, phrased for whoever has to act on it. */
  async unavailableReason(): Promise<string | null> {
    const detected = await this.detectAll()
    const driver = await this.resolve()
    if (!driver) {
      return (
        'No container runtime found. Install one from Settings — ' +
        'Docker Desktop, OrbStack, Colima or Podman.'
      )
    }
    const found = detected.get(driver.id)
    if (!found?.installed) {
      return `${driver.displayName} is selected but not installed. Install it, or choose another runtime in Settings.`
    }
    if (!found.running) {
      return driver.start
        ? `${driver.displayName} is not running. Start it from Settings.`
        : `${driver.displayName} is not running. Open it, then try again.`
    }
    return null
  }
}

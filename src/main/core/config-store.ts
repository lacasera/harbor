import { readFileSync, writeFileSync, renameSync, existsSync } from 'node:fs'
import { EventEmitter } from 'node:events'
import type { Project } from '../../shared/project.js'
import type { ServiceInstance, ServiceInstanceKey } from '../../shared/service.js'
import type { RuntimeId } from '../../shared/runtime.js'
import { paths, ensureDirs, composeProjectName } from './paths.js'

/** Bump when a shape change needs `migrate()` to touch existing state. */
export const STATE_VERSION = 3

export interface PersistedState {
  version: number
  /**
   * Every service instance, keyed `owner:serviceId`. This is the single source
   * of truth for which services exist and who owns them; a project's are the
   * ones whose owner is its id.
   */
  serviceInstances: Record<ServiceInstanceKey, ServiceInstance>
  /**
   * The version installed for each service, by service id — a property of the
   * machine (which binary is on disk, which image tag is pulled), not of any
   * one instance.
   *
   * There is deliberately no machine-wide store of service *values*. One
   * existed, to carry a tuned config into the next project that attached the
   * same service, and it was a mistake twice over: a project inherited another
   * project's binary-log settings and database name without asking, and the
   * form showed them as though they were defaults. Config that appears from
   * nowhere is worse than config you set twice.
   */
  serviceVersions: Record<string, string>
  projects: Project[]
  /** projectId → allocated port. Survives restarts so `api.test` is stable. */
  ports: Record<string, number>
  runtimeDefaults: Partial<Record<RuntimeId, string>>
  /** projectPath → { runtime: version } overrides set through the UI. */
  runtimeOverrides: Record<string, Partial<Record<RuntimeId, string>>>
  settings: {
    tld: string
    parkedDirs: string[]
    autoStartServices: boolean
    /** Ports the generated vhosts listen on. 80/443 need a root nginx. */
    httpPort: number
    httpsPort: number
  }
}

export const EMPTY_STATE: PersistedState = {
  version: STATE_VERSION,
  serviceInstances: {},
  serviceVersions: {},
  projects: [],
  ports: {},
  runtimeDefaults: {},
  runtimeOverrides: {},
  settings: {
    tld: 'test',
    parkedDirs: [],
    autoStartServices: false,
    httpPort: 80,
    httpsPort: 443
  }
}

/**
 * Single owner of persisted state. Writes are atomic (tmp + rename) because a
 * crash mid-write would otherwise lose every parked project.
 */
export class ConfigStore extends EventEmitter {
  private state: PersistedState
  private writeQueued = false
  /** Set by `load()` when the file on disk was an older shape. */
  private migrated = false

  constructor() {
    super()
    ensureDirs()
    this.state = this.load()
    // Write the migrated shape back straight away. Leaving it in memory only
    // means every launch re-derives it, and a launch that crashes before the
    // first user change would re-migrate from state a previous run had already
    // half-changed.
    if (this.migrated) this.writeNow()
  }

  private load(): PersistedState {
    if (!existsSync(paths.config)) return structuredClone(EMPTY_STATE)
    try {
      const parsed = JSON.parse(readFileSync(paths.config, 'utf8')) as Partial<PersistedState>
      const state: PersistedState = {
        ...structuredClone(EMPTY_STATE),
        ...parsed,
        settings: { ...EMPTY_STATE.settings, ...parsed.settings }
      }
      if ((parsed.version ?? 1) < STATE_VERSION) {
        this.migrated = true
        return migrate(state, parsed as Record<string, unknown>)
      }
      return state
    } catch {
      // A corrupt config must not brick the app; start clean and keep the bad
      // file next to it for forensics.
      try {
        renameSync(paths.config, `${paths.config}.corrupt-${Date.now()}`)
      } catch {
        /* best effort */
      }
      return structuredClone(EMPTY_STATE)
    }
  }

  get(): Readonly<PersistedState> {
    return this.state
  }

  update(mutate: (state: PersistedState) => void): void {
    mutate(this.state)
    this.persist()
    this.emit('changed', this.state)
  }

  private persist(): void {
    if (this.writeQueued) return
    this.writeQueued = true
    queueMicrotask(() => {
      if (!this.writeQueued) return
      this.writeQueued = false
      this.writeNow()
    })
  }

  /** Write immediately. Called on shutdown so a prompt exit cannot drop a change. */
  flush(): void {
    if (!this.writeQueued) return
    this.writeQueued = false
    this.writeNow()
  }

  private writeNow(): void {
    const tmp = `${paths.config}.tmp`
    writeFileSync(tmp, JSON.stringify(this.state, null, 2), 'utf8')
    renameSync(tmp, paths.config)
  }
}

/** Legacy shapes, only as much of them as the migration reads. */
interface LegacyServiceConfig {
  version?: string
  values?: Record<string, unknown>
}

/**
 * v1 → v2: services stop being machine-wide singletons.
 * v2 → v3: machine-wide service *values* are dropped; only the version stays.
 *
 * Deliberately creates NO instances. A v1 `services` entry says "the user
 * configured MySQL", not "some project runs MySQL" — nothing in v1 associated a
 * service with a project, so inventing that association would be a guess. The
 * containers v1 left running are reconciled by the Docker backend, which is the
 * only thing that knows what is actually up.
 */
export function migrate(state: PersistedState, parsed: Record<string, unknown>): PersistedState {
  // v1 `services` and v2 `serviceDefaults` are the same shape and both collapse
  // to a version pin. Their values are discarded on purpose: a port belongs to
  // an instance, and credentials shared across projects are what this whole
  // change exists to end.
  const legacy = {
    ...((parsed.services ?? {}) as Record<string, LegacyServiceConfig>),
    ...((parsed.serviceDefaults ?? {}) as Record<string, LegacyServiceConfig>)
  }
  for (const [id, config] of Object.entries(legacy)) {
    if (!config || typeof config !== 'object') continue
    if (config.version) state.serviceVersions[id] = config.version
  }
  const raw = state as unknown as Record<string, unknown>
  delete raw.services
  delete raw.serviceDefaults

  // Assign each project a compose namespace, uniquely: two directories can both
  // be called `api`, and sharing a namespace would put both stacks' containers
  // and volumes in one place.
  const taken = new Set<string>()
  for (const project of state.projects) {
    const stale = project as Project & { serviceIds?: string[] }
    delete stale.serviceIds
    if (!project.composeProject) {
      project.composeProject = composeProjectName(project.name, taken)
    }
    taken.add(project.composeProject)
  }

  state.version = STATE_VERSION
  return state
}

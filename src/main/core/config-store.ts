import { readFileSync, writeFileSync, renameSync, existsSync } from 'node:fs'
import { EventEmitter } from 'node:events'
import type { Project } from '../../shared/project.js'
import type { ServiceConfig } from '../../shared/service.js'
import type { RuntimeId } from '../../shared/runtime.js'
import { paths, ensureDirs } from './paths.js'

export interface PersistedState {
  version: number
  services: Record<string, ServiceConfig>
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

const EMPTY: PersistedState = {
  version: 1,
  services: {},
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

  constructor() {
    super()
    ensureDirs()
    this.state = this.load()
  }

  private load(): PersistedState {
    if (!existsSync(paths.config)) return structuredClone(EMPTY)
    try {
      const parsed = JSON.parse(readFileSync(paths.config, 'utf8')) as Partial<PersistedState>
      return { ...structuredClone(EMPTY), ...parsed, settings: { ...EMPTY.settings, ...parsed.settings } }
    } catch {
      // A corrupt config must not brick the app; start clean and keep the bad
      // file next to it for forensics.
      try {
        renameSync(paths.config, `${paths.config}.corrupt-${Date.now()}`)
      } catch {
        /* best effort */
      }
      return structuredClone(EMPTY)
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

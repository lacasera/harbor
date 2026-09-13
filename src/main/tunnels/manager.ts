import { EventEmitter } from 'node:events'
import type { ActiveTunnel, TunnelProviderId, TunnelStatus } from '../../shared/tunnel.js'
import type { ProcessHandle } from '../../shared/process.js'
import type { ConfigStore } from '../core/config-store.js'
import type { LogAggregator } from '../core/log-aggregator.js'
import type { ProcessManager } from '../core/process-manager.js'
import type { Notifier } from '../core/notifier.js'
import type { TunnelProviders } from './registry.js'
import type { TunnelDriver, TunnelOrigin } from './types.js'

/** The bit of a project a tunnel needs; resolved through Harbor's project store. */
export interface TunnelProjectInfo {
  name: string
  domain: string
  secure: boolean
}

export type TunnelProjectResolver = (projectId: string) => TunnelProjectInfo | null

export interface TunnelManagerOptions {
  /** How long to wait for the provider to print a public URL after spawning. */
  urlTimeoutMs?: number
  /** First restart delay; doubles per consecutive quick failure. */
  backoffBaseMs?: number
  /** Ceiling for the restart delay, so an outage never becomes a busy loop. */
  backoffMaxMs?: number
  /** A run that stays up at least this long resets the backoff. */
  stableMs?: number
}

/** Everything the manager keeps per exposed project. Never crosses IPC. */
interface Tracked {
  active: ActiveTunnel
  driver: TunnelDriver
  origin: TunnelOrigin
  /** ProcessManager id of the current tunnel process. */
  handleId: string | null
  restartTimer: NodeJS.Timeout | null
  /** Consecutive quick failures, for backoff. */
  failures: number
  lastSpawnAt: number
  /** Resolve callbacks waiting for the first URL of the current spawn. */
  urlWaiters: Array<(url: string | null) => void>
  /** Whether the "now public" notice has been raised for this exposure. */
  announced: boolean
  lastAnnouncedUrl: string | null
}

/**
 * Supervises public tunnels.
 *
 * A tunnel is a per-project process, spawned through `ProcessManager` like
 * everything else — it is never persisted, never auto-started, and does not
 * survive a Harbor restart, because exposing a local machine to the internet
 * must be a deliberate act with a clear end. While one is deliberately up this
 * notices the process dying, restarts it with a backoff, and notifies — and on
 * an ephemeral provider the notice carries the *new* URL, because a silent URL
 * change is what breaks whatever was pointed at the old one.
 */
export class TunnelManager extends EventEmitter {
  private readonly tracked = new Map<string, Tracked>()
  private shuttingDown = false

  private readonly urlTimeoutMs: number
  private readonly backoffBaseMs: number
  private readonly backoffMaxMs: number
  private readonly stableMs: number

  constructor(
    private readonly providers: TunnelProviders,
    private readonly processes: ProcessManager,
    private readonly notifier: Notifier,
    private readonly logs: LogAggregator,
    private readonly store: ConfigStore,
    private readonly resolveProject: TunnelProjectResolver,
    options: TunnelManagerOptions = {}
  ) {
    super()
    this.urlTimeoutMs = options.urlTimeoutMs ?? 25_000
    this.backoffBaseMs = options.backoffBaseMs ?? 1_000
    this.backoffMaxMs = options.backoffMaxMs ?? 30_000
    this.stableMs = options.stableMs ?? 60_000

    this.processes.on('changed', (handle: ProcessHandle) => this.onProcessChanged(handle))
    this.processes.on('log', ({ handle, chunk }: { handle: ProcessHandle; chunk: string }) =>
      this.onProcessLog(handle, chunk)
    )
  }

  // ------------------------------------------------------------------ status

  defaultProvider(): TunnelProviderId {
    const chosen = this.store.get().settings.tunnelProvider
    return chosen && this.providers.has(chosen) ? chosen : 'cloudflared'
  }

  async status(): Promise<TunnelStatus> {
    const providers = await Promise.all(this.providers.all().map((d) => d.probe()))
    return { defaultProvider: this.defaultProvider(), providers, active: this.activeList() }
  }

  activeList(): ActiveTunnel[] {
    return [...this.tracked.values()].map((t) => ({ ...t.active }))
  }

  async install(provider: TunnelProviderId): Promise<void> {
    await this.providers.get(provider).install()
  }

  // ------------------------------------------------------------- lifecycle

  /**
   * Expose a project. Refuses before doing anything if the provider is not
   * installed or not authenticated — with the install command or the exact
   * missing credential — so the failure is at the point of asking, never a bare
   * "command not found" at spawn time.
   */
  async start(projectId: string, provider?: TunnelProviderId): Promise<ActiveTunnel> {
    const info = this.resolveProject(projectId)
    if (!info) throw new Error(`No project "${projectId}"`)

    const existing = this.tracked.get(projectId)
    if (existing) return { ...existing.active }

    const providerId = provider ?? this.defaultProvider()
    const driver = this.providers.get(providerId)
    const capability = await driver.probe()
    if (!capability.installed) {
      throw Object.assign(
        new Error(`${driver.displayName} is not installed.`),
        { needsInstall: providerId }
      )
    }
    if (!capability.authenticated) {
      throw new Error(
        capability.authHint ?? `${driver.displayName} is not authenticated.`
      )
    }

    const tracked: Tracked = {
      active: {
        projectId,
        projectName: info.name,
        domain: info.domain,
        provider: providerId,
        url: null,
        hostname: capability.hostname,
        startedAt: Date.now(),
        restarts: 0,
        state: 'starting'
      },
      driver,
      origin: this.originFor(info),
      handleId: null,
      restartTimer: null,
      failures: 0,
      lastSpawnAt: 0,
      urlWaiters: [],
      announced: false,
      lastAnnouncedUrl: null
    }
    this.tracked.set(projectId, tracked)
    this.logs.push(projectId, 'tunnel', `exposing ${info.domain} via ${driver.displayName}`)

    await this.spawn(tracked)
    const url = await this.awaitUrl(tracked)
    if (!url) {
      this.logs.push(projectId, 'tunnel', 'no public URL yet — the provider is still connecting')
    }
    return { ...tracked.active }
  }

  /**
   * Take a tunnel down. Intent is removed FIRST, so the process's own exit event
   * is seen as deliberate and never triggers the auto-restart.
   */
  async stop(projectId: string): Promise<void> {
    const tracked = this.tracked.get(projectId)
    if (!tracked) return
    this.tracked.delete(projectId)
    if (tracked.restartTimer) clearTimeout(tracked.restartTimer)
    this.drainWaiters(tracked, tracked.active.url)
    if (tracked.handleId) await this.processes.stop(tracked.handleId).catch(() => undefined)
    this.logs.push(projectId, 'tunnel', 'tunnel stopped — the project is no longer public')
    this.emit('closed', projectId)
  }

  /** Bring every tunnel down. Called on shutdown, before ProcessManager.stopAll. */
  async stopAll(): Promise<void> {
    this.shuttingDown = true
    for (const id of [...this.tracked.keys()]) {
      await this.stop(id).catch(() => undefined)
    }
  }

  // --------------------------------------------------------------- internals

  private originFor(info: TunnelProjectInfo): TunnelOrigin {
    const { httpPort, httpsPort } = this.store.get().settings
    return {
      domain: info.domain,
      host: '127.0.0.1',
      port: info.secure ? httpsPort : httpPort,
      secure: info.secure
    }
  }

  private async spawn(tracked: Tracked): Promise<void> {
    const plan = tracked.driver.plan(tracked.origin)
    tracked.lastSpawnAt = Date.now()
    const handle = await this.processes.spawn({
      owner: { kind: 'project', id: tracked.active.projectId, role: 'tunnel' },
      label: `${tracked.active.projectName} tunnel (${tracked.driver.displayName})`,
      command: plan.command,
      args: plan.args,
      env: plan.env,
      logStream: 'tunnel'
    })
    tracked.handleId = handle.id
  }

  /** Resolve once the current spawn prints a URL, or after the timeout. */
  private awaitUrl(tracked: Tracked): Promise<string | null> {
    if (tracked.active.url) return Promise.resolve(tracked.active.url)
    return new Promise<string | null>((resolve) => {
      const timer = setTimeout(() => finish(null), this.urlTimeoutMs)
      const finish = (url: string | null): void => {
        clearTimeout(timer)
        resolve(url)
      }
      tracked.urlWaiters.push(finish)
    })
  }

  private drainWaiters(tracked: Tracked, url: string | null): void {
    const waiters = tracked.urlWaiters.splice(0, tracked.urlWaiters.length)
    for (const w of waiters) w(url)
  }

  private onProcessLog(handle: ProcessHandle, chunk: string): void {
    if (handle.owner.role !== 'tunnel') return
    const tracked = this.tracked.get(handle.owner.id)
    if (!tracked || tracked.handleId !== handle.id || tracked.active.url) return
    for (const line of chunk.split('\n')) {
      const url = tracked.driver.parseUrl(line)
      if (url) {
        this.deliverUrl(tracked, url)
        return
      }
    }
  }

  private deliverUrl(tracked: Tracked, url: string): void {
    tracked.active.url = url
    tracked.active.state = 'live'
    const { projectName, domain, projectId } = tracked.active

    if (!tracked.announced) {
      tracked.announced = true
      // Loud at start: name what is now public, not just a URL.
      this.notifier.notify({
        level: 'warn',
        title: `${projectName} is now public`,
        message:
          `${url}\nAnyone with this link can reach ${domain}. ` +
          `Exposure ends when you run 'harbor tunnel stop ${projectName}' or Harbor quits.`,
        source: projectId
      })
    } else if (tracked.active.hostname === 'reserved' && url === tracked.lastAnnouncedUrl) {
      // A reserved hostname survived the restart: genuinely invisible.
      this.notifier.notify({
        level: 'info',
        title: `${projectName} tunnel reconnected`,
        message: `Same URL: ${url}`,
        source: projectId
      })
    } else {
      // Ephemeral (or a changed URL): whatever was pointed at the old one is now
      // broken, so the new URL is the point of the message.
      this.notifier.notify({
        level: 'warn',
        title: `${projectName} tunnel restarted — new URL`,
        message: `The public URL is now ${url}. Update anything pointed at the old one.`,
        source: projectId
      })
    }

    tracked.lastAnnouncedUrl = url
    this.logs.push(projectId, 'tunnel', `public at ${url}`)
    this.drainWaiters(tracked, url)
    this.emit('changed', { ...tracked.active })
  }

  private onProcessChanged(handle: ProcessHandle): void {
    if (handle.owner.role !== 'tunnel') return
    if (handle.state !== 'stopped' && handle.state !== 'crashed') return
    const tracked = this.tracked.get(handle.owner.id)
    // Not tracked → deliberately stopped (intent is removed before the process
    // is). Stale handle → an old process from before a restart. Either way, no
    // restart.
    if (!tracked || tracked.handleId !== handle.id || this.shuttingDown) return
    this.scheduleRestart(tracked, handle)
  }

  private scheduleRestart(tracked: Tracked, handle: ProcessHandle): void {
    const ranFor = Date.now() - tracked.lastSpawnAt
    if (ranFor > this.stableMs) tracked.failures = 0
    const delay = Math.min(this.backoffMaxMs, this.backoffBaseMs * 2 ** tracked.failures)
    tracked.failures += 1

    tracked.active.restarts += 1
    tracked.active.state = 'restarting'
    // The old URL is dead the moment the process is; drop it and re-await one, so
    // an ephemeral restart cannot report a stale URL as live.
    tracked.active.url = null
    this.drainWaiters(tracked, null)
    this.logs.push(
      tracked.active.projectId,
      'tunnel',
      `tunnel exited (${handle.exitCode === null ? 'signal' : `code ${handle.exitCode}`}); ` +
        `restarting in ${Math.round(delay / 1000)}s`
    )
    this.emit('changed', { ...tracked.active })

    tracked.restartTimer = setTimeout(() => {
      tracked.restartTimer = null
      if (!this.tracked.has(tracked.active.projectId) || this.shuttingDown) return
      void this.spawn(tracked).catch((err: Error) => {
        tracked.active.state = 'error'
        tracked.active.error = err.message
        this.logs.push(tracked.active.projectId, 'tunnel', `restart failed: ${err.message}`)
        this.emit('changed', { ...tracked.active })
      })
    }, delay)
  }
}

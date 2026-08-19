import { app, dialog, ipcMain, type BrowserWindow } from 'electron'
import type {
  IpcArgs,
  IpcChannel,
  IpcContract,
  IpcEventName,
  IpcEvents,
  IpcResult
} from '../../shared/ipc.js'
import type { HarborApp } from '../app.js'
import { HARBOR_HOME } from '../core/paths.js'
import { Updater } from '../updater.js'
import { readProjectEnv } from '../projects/env-file.js'

/** Typed `handle` — the channel name pins both the args and the return type. */
function makeHandle(
  onError: (channel: string, message: string) => void
): <C extends IpcChannel>(
  channel: C,
  fn: (...args: IpcArgs<C>) => Promise<IpcResult<C>> | IpcResult<C>
) => void {
  return (channel, fn) => {
    ipcMain.handle(channel, async (_event, ...args) => {
      try {
        return await fn(...(args as IpcArgs<typeof channel>))
      } catch (err) {
        // Surface it in the log viewer as well as rejecting: a failure the user
        // dismissed should still be findable afterwards.
        onError(channel, (err as Error).message)
        throw err
      }
    })
  }
}

export function registerIpc(harbor: HarborApp, getWindow: () => BrowserWindow | null): void {
  const handle = makeHandle((channel, message) => {
    harbor.logs.push('harbor', 'ipc', `${channel} failed: ${message}`)
  })

  const send = <E extends IpcEventName>(event: E, payload: IpcEvents[E]): void => {
    getWindow()?.webContents.send(event, payload)
  }

  // ── push channels ───────────────────────────────────────────────────────
  harbor.logs.on('line', (line) => send('log:line', line))
  harbor.services.on('changed', (descriptor) => send('service:changed', descriptor))
  harbor.projects.on('changed', (descriptor) => send('project:changed', descriptor))
  harbor.processes.on('changed', (handleUpdate) => send('process:changed', handleUpdate))
  harbor.processes.on('usage', (samples) => send('usage:sample', samples))
  harbor.intelligence.on('invalidated', (projectId: string) =>
    send('analysis:invalidated', projectId)
  )

  const updater = new Updater(harbor.logs)

  // ── app ─────────────────────────────────────────────────────────────────
  handle('app:info', () => ({
    name: 'Harbor',
    version: app.getVersion(),
    homeDir: HARBOR_HOME
  }))
  handle('app:checkForUpdates', () => updater.check())

  // ── services ────────────────────────────────────────────────────────────
  handle('services:list', () => harbor.services.describeAll())
  handle('services:install', (id, version) => harbor.services.install(id, version))
  handle('services:start', (id) => harbor.services.start(id))
  handle('services:stop', (id) => harbor.services.stop(id))
  handle('services:updateConfig', (id, config) => harbor.services.updateConfig(id, config))
  handle('services:envBlock', (id) => harbor.services.envBlock(id))
  handle('services:envBlocks', (ids) => harbor.services.envBlocks(ids))

  // ── runtimes ────────────────────────────────────────────────────────────
  handle('runtimes:list', () => harbor.runtimes.describeAll())
  handle('runtimes:available', (id) => harbor.runtimes.get(id).availableVersions())
  handle('runtimes:install', (id, version) => harbor.runtimes.get(id).install(version))
  handle('runtimes:uninstall', (id, version) => harbor.runtimes.get(id).uninstall(version))
  handle('runtimes:resolve', (id, path) => harbor.runtimes.resolve(id, path))
  handle('runtimes:setDefault', async (id, version) => {
    harbor.store.update((s) => {
      s.runtimeDefaults[id] = version
    })
    return harbor.runtimes.describeAll()
  })

  // ── projects ────────────────────────────────────────────────────────────
  handle('projects:list', () => harbor.projects.describeAll())
  handle('projects:park', (dir) => harbor.projects.park(dir))
  handle('projects:link', (dir) => harbor.projects.link(dir))
  handle('projects:forget', (id) => harbor.projects.forget(id))
  handle('projects:start', (id) => harbor.projects.start(id))
  handle('projects:stop', (id) => harbor.projects.stop(id))
  handle('projects:update', (id, patch) => harbor.projects.update(id, patch))
  handle('projects:envFile', async (projectId) =>
    readProjectEnv(harbor.projects.find(projectId).path)
  )
  handle('projects:chooseDirectory', async () => {
    const window = getWindow()
    const result = window
      ? await dialog.showOpenDialog(window, { properties: ['openDirectory'] })
      : await dialog.showOpenDialog({ properties: ['openDirectory'] })
    return result.canceled ? null : (result.filePaths[0] ?? null)
  })

  // ── processes ───────────────────────────────────────────────────────────
  handle('processes:list', () => harbor.processes.list())
  handle('processes:stop', (id) => harbor.processes.stop(id))
  handle('processes:usage', () => harbor.processes.sampleUsage())

  // ── logs ────────────────────────────────────────────────────────────────
  handle('logs:query', (query) => harbor.logs.query(query))
  handle('logs:sources', () => harbor.logs.knownSources())
  handle('logs:clear', () => harbor.logs.clear())

  // ── code intelligence ───────────────────────────────────────────────────
  handle('intelligence:analyze', (projectId, force) =>
    harbor.intelligence.analyze(harbor.projects.find(projectId), force ?? false)
  )
  handle('intelligence:mermaid', async (projectId, kind) => {
    const results = await harbor.intelligence.analyze(harbor.projects.find(projectId))
    return harbor.intelligence.mermaid(results, kind)
  })

  // ── settings & system ───────────────────────────────────────────────────
  handle('settings:get', () => ({ ...harbor.store.get().settings }))
  handle('settings:update', async (patch) => {
    const before = { ...harbor.store.get().settings }
    harbor.store.update((s) => {
      Object.assign(s.settings, patch)
    })
    const after = harbor.store.get().settings

    // Settings that other state is derived from have to propagate, or the
    // control silently does nothing.
    if (patch.tld && after.tld !== before.tld) {
      const result = await harbor.projects.changeTld(after.tld)
      harbor.logs.push(
        'harbor',
        'settings',
        `TLD ${before.tld} → ${after.tld}: ${result.renamed.length} site(s) re-homed` +
          (result.failed.length ? `, ${result.failed.length} failed` : '')
      )
      // dnsmasq answers for one TLD; restart it on the new one.
      await harbor.dns.start(after.tld).catch(() => undefined)
    }

    if (
      (patch.httpPort && after.httpPort !== before.httpPort) ||
      (patch.httpsPort && after.httpsPort !== before.httpsPort)
    ) {
      await harbor.projects.rewriteAllVhosts().catch(() => undefined)
    }

    return { ...after }
  })
  const tld = (): string => harbor.store.get().settings.tld

  handle('tls:status', () => harbor.tls.status())
  handle('tls:install', async () => {
    await harbor.tls.install()
    return harbor.tls.status()
  })
  handle('tls:installCa', async () => {
    await harbor.tls.installCa()
    return harbor.tls.status()
  })

  handle('dns:status', () => harbor.dns.status(tld()))
  handle('dns:install', async () => {
    await harbor.dns.install()
    return harbor.dns.status(tld())
  })
  handle('dns:start', async () => {
    await harbor.dns.start(tld())
    return harbor.dns.status(tld())
  })
  handle('dns:stop', async () => {
    await harbor.dns.stop()
    return harbor.dns.status(tld())
  })
  handle('dns:flush', async () => {
    await harbor.dns.flushDnsCache()
    return harbor.dns.status(tld())
  })
  handle('dns:configureResolver', async () => {
    await harbor.dns.configureResolver(tld())
    return harbor.dns.status(tld())
  })

  // ── nginx ───────────────────────────────────────────────────────────────
  handle('nginx:status', () => harbor.projects.nginx.status())
  handle('nginx:reload', () => harbor.projects.nginx.reload())
  handle('nginx:connect', async () => {
    const { httpPort, httpsPort } = harbor.store.get().settings
    await harbor.projects.nginx.connect({ httpPort, httpsPort })
    return harbor.projects.nginx.status()
  })
  handle('nginx:restart', async () => {
    const { httpPort, httpsPort } = harbor.store.get().settings
    await harbor.projects.nginx.restart({ httpPort, httpsPort })
    return harbor.projects.nginx.status()
  })
  handle('nginx:disconnect', async () => {
    await harbor.projects.nginx.disconnect()
    return harbor.projects.nginx.status()
  })
}

/** Compile-time guard: every channel in the contract must be handled above. */
export type RegisteredChannels = keyof IpcContract

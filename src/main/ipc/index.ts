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

/** Typed `handle` — the channel name pins both the args and the return type. */
function handle<C extends IpcChannel>(
  channel: C,
  fn: (...args: IpcArgs<C>) => Promise<IpcResult<C>> | IpcResult<C>
): void {
  ipcMain.handle(channel, async (_event, ...args: unknown[]) =>
    fn(...(args as IpcArgs<C>))
  )
}

export function registerIpc(harbor: HarborApp, getWindow: () => BrowserWindow | null): void {
  const send = <E extends IpcEventName>(event: E, payload: IpcEvents[E]): void => {
    getWindow()?.webContents.send(event, payload)
  }

  // ── push channels ───────────────────────────────────────────────────────
  harbor.logs.on('line', (line) => send('log:line', line))
  harbor.services.on('changed', (descriptor) => send('service:changed', descriptor))
  harbor.projects.on('changed', (descriptor) => send('project:changed', descriptor))
  harbor.processes.on('changed', (handleUpdate) => send('process:changed', handleUpdate))
  harbor.processes.on('usage', (samples) => send('usage:sample', samples))

  // ── app ─────────────────────────────────────────────────────────────────
  handle('app:info', () => ({
    name: 'Harbor',
    version: app.getVersion(),
    homeDir: HARBOR_HOME
  }))

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
  handle('settings:update', (patch) => {
    harbor.store.update((s) => {
      Object.assign(s.settings, patch)
    })
    return { ...harbor.store.get().settings }
  })
  handle('tls:status', () => harbor.tls.status())
  handle('dns:status', () => harbor.dns.status(harbor.store.get().settings.tld))

  // ── nginx ───────────────────────────────────────────────────────────────
  handle('nginx:status', () => harbor.projects.nginx.status())
  handle('nginx:reload', () => harbor.projects.nginx.reload())
}

/** Compile-time guard: every channel in the contract must be handled above. */
export type RegisteredChannels = keyof IpcContract

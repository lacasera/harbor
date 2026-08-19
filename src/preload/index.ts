import { contextBridge, ipcRenderer } from 'electron'
import type {
  HarborBridge,
  IpcArgs,
  IpcChannel,
  IpcEventName,
  IpcEvents,
  IpcResult
} from '../shared/ipc.js'

/**
 * The only surface the renderer gets. No node integration, no fs, no spawning —
 * everything is a typed round trip to the main process.
 */
const bridge: HarborBridge = {
  invoke<C extends IpcChannel>(channel: C, ...args: IpcArgs<C>): Promise<IpcResult<C>> {
    return ipcRenderer.invoke(channel, ...args) as Promise<IpcResult<C>>
  },
  on<E extends IpcEventName>(event: E, listener: (payload: IpcEvents[E]) => void): () => void {
    const handler = (_e: Electron.IpcRendererEvent, payload: IpcEvents[E]): void => listener(payload)
    ipcRenderer.on(event, handler)
    return () => {
      ipcRenderer.removeListener(event, handler)
    }
  }
}

if (process.contextIsolated) {
  contextBridge.exposeInMainWorld('harbor', bridge)
} else {
  // Only reachable in a misconfigured dev build; keeps the app bootable.
  ;(globalThis as unknown as { harbor: HarborBridge }).harbor = bridge
}

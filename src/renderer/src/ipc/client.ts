import type {
  IpcArgs,
  IpcChannel,
  IpcEventName,
  IpcEvents,
  IpcResult
} from '../../../shared/ipc.js'

/**
 * The renderer's only door to the main process. Everything else in /renderer is
 * presentation — no fs, no child_process, no privileged calls.
 */
export function invoke<C extends IpcChannel>(
  channel: C,
  ...args: IpcArgs<C>
): Promise<IpcResult<C>> {
  return window.harbor.invoke(channel, ...args)
}

export function subscribe<E extends IpcEventName>(
  event: E,
  listener: (payload: IpcEvents[E]) => void
): () => void {
  return window.harbor.on(event, listener)
}

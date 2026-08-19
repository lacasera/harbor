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
  return window.harbor.invoke(channel, ...args).catch((err: unknown) => {
    throw new Error(cleanMessage(err))
  })
}

/**
 * Electron wraps a rejected handler as
 *   Error invoking remote method 'services:start': Error: <the real message>
 * Showing that verbatim puts IPC plumbing in front of the user instead of the
 * reason their service failed to start.
 */
export function cleanMessage(err: unknown): string {
  const raw = err instanceof Error ? err.message : String(err)
  const match = /Error invoking remote method '[^']+':\s*(?:Error:\s*)?([\s\S]*)$/.exec(raw)
  return (match?.[1] ?? raw).trim() || 'Something went wrong'
}

export function subscribe<E extends IpcEventName>(
  event: E,
  listener: (payload: IpcEvents[E]) => void
): () => void {
  return window.harbor.on(event, listener)
}

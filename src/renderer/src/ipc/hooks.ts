import { useCallback, useEffect, useState } from 'react'
import type { IpcArgs, IpcChannel, IpcEventName, IpcEvents, IpcResult } from '../../../shared/ipc.js'
import { invoke, subscribe } from './client.js'

/** Fetch-on-mount with a manual `reload`. Good enough for a local-first UI. */
export function useIpc<C extends IpcChannel>(
  channel: C,
  args: IpcArgs<C>,
  deps: unknown[] = []
): { data: IpcResult<C> | null; error: string | null; loading: boolean; reload: () => void } {
  const [data, setData] = useState<IpcResult<C> | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [nonce, setNonce] = useState(0)

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    invoke(channel, ...args)
      .then((result) => {
        if (!cancelled) {
          setData(result)
          setError(null)
        }
      })
      .catch((err: Error) => {
        if (!cancelled) setError(err.message)
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [channel, nonce, ...deps])

  const reload = useCallback(() => setNonce((n) => n + 1), [])
  return { data, error, loading, reload }
}

export function useIpcEvent<E extends IpcEventName>(
  event: E,
  listener: (payload: IpcEvents[E]) => void
): void {
  useEffect(() => subscribe(event, listener), [event, listener])
}

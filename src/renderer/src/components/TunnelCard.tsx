import { useCallback, useEffect, useState } from 'react'
import type { ProjectDescriptor } from '../../../shared/project.js'
import type { ActiveTunnel, TunnelCapability, TunnelStatus } from '../../../shared/tunnel.js'
import { invoke, subscribe } from '../ipc/client.js'
import { CopyIconButton, StatusDot, useCopy } from './primitives.js'
import { ExternalLink } from './ExternalLink.js'

/**
 * Start and stop a public tunnel for one project, and make an exposed project
 * read as exposed at a glance — per the captain's note that the CLI must not be
 * the only way in, and that a tunnel you can only see from a terminal is one you
 * forget is running.
 *
 * Self-contained: it owns its own IPC and its own subscription, so dropping it
 * into a project's overview is the whole integration.
 */
export function TunnelCard({
  project,
  onExposedChange
}: {
  project: ProjectDescriptor
  onExposedChange?: (exposed: boolean) => void
}): React.JSX.Element {
  const [status, setStatus] = useState<TunnelStatus | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const { copied, copy } = useCopy()

  const refresh = useCallback(async () => {
    setStatus(await invoke('tunnel:status'))
  }, [])

  useEffect(() => {
    void refresh()
    // A tunnel changes state on its own — it goes live, restarts with a new URL,
    // or dies — so the card follows the live pushes rather than only its buttons.
    const offChanged = subscribe('tunnel:changed', (t) => {
      if (t.projectId === project.id) void refresh()
    })
    const offClosed = subscribe('tunnel:closed', () => void refresh())
    return () => {
      offChanged()
      offClosed()
    }
  }, [project.id, refresh])

  const active: ActiveTunnel | undefined = status?.active.find((a) => a.projectId === project.id)
  const provider: TunnelCapability | undefined = status?.providers.find(
    (p) => p.provider === status.defaultProvider
  )

  useEffect(() => onExposedChange?.(Boolean(active)), [active, onExposedChange])

  const act = async (fn: () => Promise<unknown>): Promise<void> => {
    setBusy(true)
    setError(null)
    try {
      await fn()
      await refresh()
    } catch (err) {
      setError((err as Error).message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="card card-pad">
      <div className="hstack" style={{ justifyContent: 'space-between', marginBottom: 4 }}>
        <span style={{ fontSize: 12.5, fontWeight: 600 }}>Public tunnel</span>
        {active && (
          <span className="hstack" style={{ gap: 6, fontSize: 11.5, color: 'var(--am)' }}>
            <StatusDot status={active.state === 'live' ? 'running' : 'busy'} small />
            {active.state === 'live' ? 'Public' : active.state}
          </span>
        )}
      </div>

      {active ? (
        <>
          <div className="hint" style={{ marginBottom: 8, color: 'var(--am)' }}>
            {project.domain} is reachable by anyone with the link. Exposure ends when Harbor quits.
          </div>
          {active.url ? (
            <div className="hstack" style={{ gap: 6, marginBottom: 8 }}>
              <ExternalLink className="mono" style={{ fontSize: 12.5 }} href={active.url}>
                {active.url}
              </ExternalLink>
              <CopyIconButton
                text={active.url}
                copyKey="tunnel"
                copied={copied}
                copy={copy}
                title="Copy public URL"
              />
            </div>
          ) : (
            <div className="small muted" style={{ marginBottom: 8 }}>
              Connecting… the {active.provider} URL will appear here.
            </div>
          )}
          <div className="small muted" style={{ marginBottom: 10 }}>
            via {active.provider} · {active.hostname}
            {active.restarts > 0 ? ` · ${active.restarts} restart(s)` : ''}
            {active.hostname === 'ephemeral' ? ' · URL changes if it restarts' : ''}
          </div>
          <button
            type="button"
            className="btn xs"
            disabled={busy}
            onClick={() => void act(() => invoke('tunnel:stop', project.id))}
          >
            Stop tunnel
          </button>
        </>
      ) : (
        <>
          <div className="hint" style={{ marginBottom: 10 }}>
            Expose {project.domain} to the internet with a publicly-trusted certificate — for a
            phone, an emulator, or a webhook. Never automatic.
          </div>
          {provider && !provider.installed ? (
            <button
              type="button"
              className="btn xs"
              disabled={busy}
              onClick={() => void act(() => invoke('tunnel:install', provider.provider))}
            >
              Install {provider.displayName}
            </button>
          ) : provider && !provider.authenticated ? (
            <div className="small" style={{ color: 'var(--am)' }}>
              {provider.authHint ?? `${provider.displayName} is not authenticated.`}
            </div>
          ) : (
            <button
              type="button"
              className="btn xs"
              disabled={busy}
              onClick={() => void act(() => invoke('tunnel:start', project.id))}
            >
              Expose to the internet
            </button>
          )}
        </>
      )}

      {error && (
        <p className="small" style={{ color: 'var(--rd)', marginTop: 10 }}>
          {error}
        </p>
      )}
    </div>
  )
}

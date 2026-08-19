import { useState } from 'react'
import type { RuntimeDescriptor, RuntimeId } from '../../../shared/runtime.js'
import type { ProjectDescriptor } from '../../../shared/project.js'
import { invoke } from '../ipc/client.js'
import { BrandTile } from './BrandIcon.js'

export function RuntimesView({
  runtimes,
  projects,
  onReload
}: {
  runtimes: RuntimeDescriptor[]
  projects: ProjectDescriptor[]
  onReload: () => void
}): React.JSX.Element {
  const [openInstall, setOpenInstall] = useState<string | null>(null)
  const [available, setAvailable] = useState<Record<string, string[]>>({})
  const [query, setQuery] = useState('')
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  const openFor = async (id: RuntimeId): Promise<void> => {
    if (openInstall === id) {
      setOpenInstall(null)
      return
    }
    setOpenInstall(id)
    setQuery('')
    setError(null)
    if (available[id]) return
    try {
      const versions = await invoke('runtimes:available', id)
      setAvailable((a) => ({ ...a, [id]: versions }))
    } catch (err) {
      setError((err as Error).message)
    }
  }

  const act = async (key: string, fn: () => Promise<unknown>): Promise<void> => {
    setBusy(key)
    setError(null)
    try {
      await fn()
      onReload()
    } catch (err) {
      setError((err as Error).message)
    } finally {
      setBusy(null)
    }
  }

  const totalVersions = runtimes.reduce((n, r) => n + r.installedVersions.length, 0)

  return (
    <>
      <div className="page-head">
        <div>
          <div className="page-title">Runtimes</div>
          <div className="page-sub">
            {totalVersions} versions installed across {runtimes.length} runtimes · isolated under
            ~/.harbor
          </div>
        </div>
      </div>

      <div className="page-body">
        {error && <p className="error-text">{error}</p>}

        <div className="stack" style={{ maxWidth: 1000, gap: 14 }}>
          {runtimes.map((runtime) => {
            const remote = (available[runtime.id] ?? []).filter(
              (v) => !query || v.startsWith(query)
            )
            return (
              <div key={runtime.id} className="card">
                <div className="runtime-head">
                  <BrandTile id={runtime.id} size={28}>
                    <span className="rt-mono-text">{runtime.displayName.slice(0, 4)}</span>
                  </BrandTile>
                  <span style={{ fontSize: 13.5, fontWeight: 600 }}>{runtime.displayName}</span>
                  <span className="small muted" style={{ fontSize: 12 }}>
                    {runtime.installedVersions.length}{' '}
                    {runtime.installedVersions.length === 1 ? 'version' : 'versions'}
                  </span>
                  <div className="grow" />
                  <span className="mono small muted">
                    default {runtime.defaultVersion ?? runtime.installedVersions[0] ?? '—'}
                  </span>
                  <button
                    type="button"
                    className="btn sm"
                    style={{ height: 27 }}
                    onClick={() => void openFor(runtime.id)}
                  >
                    {openInstall === runtime.id ? 'Close' : 'Install version…'}
                  </button>
                </div>

                {openInstall === runtime.id && (
                  <div className="rt-install">
                    <div className="search" style={{ maxWidth: 300, background: 'var(--pn)' }}>
                      <span className="ring" />
                      <input
                        className="mono"
                        placeholder="Search remote versions…"
                        value={query}
                        onChange={(e) => setQuery(e.target.value)}
                      />
                    </div>
                    <div style={{ display: 'flex', flexDirection: 'column', marginTop: 10 }}>
                      {remote.slice(0, 8).map((version) => {
                        const installed = runtime.installedVersions.includes(version)
                        const key = `${runtime.id}@${version}`
                        return (
                          <div key={version} className="rt-remote">
                            <span className="mono" style={{ fontSize: 12, color: 'var(--tx2)' }}>
                              {version}
                            </span>
                            <div className="grow" />
                            <button
                              type="button"
                              className="btn xs"
                              disabled={installed || busy === key}
                              onClick={() =>
                                void act(key, () =>
                                  invoke('runtimes:install', runtime.id, version)
                                )
                              }
                            >
                              {installed ? 'Installed' : busy === key ? 'Installing…' : 'Install'}
                            </button>
                          </div>
                        )
                      })}
                      {!remote.length && (
                        <span className="small muted">No matching remote versions.</span>
                      )}
                    </div>
                  </div>
                )}

                {runtime.installedVersions.map((version) => {
                  const users = projects.filter(
                    (p) =>
                      p.resolvedRuntime?.runtime === runtime.id &&
                      p.resolvedRuntime.version === version
                  )
                  const isDefault = runtime.defaultVersion === version
                  const key = `${runtime.id}#${version}`
                  return (
                    <div key={version} className="rt-version">
                      <div className="hstack" style={{ gap: 8 }}>
                        <span
                          className="mono"
                          style={{ fontSize: 12.5, color: isDefault ? 'var(--tx)' : 'var(--tx2)' }}
                        >
                          {runtime.displayName} {version}
                        </span>
                        {isDefault && <span className="pill default-ver">default</span>}
                      </div>

                      <div className="hstack" style={{ gap: 5 }}>
                        {users.map((p) => (
                          <span key={p.id} className="pill mono">
                            {p.name}
                          </span>
                        ))}
                        {!users.length && <span className="small muted">unused</span>}
                      </div>

                      <div className="hstack" style={{ gap: 6, flexWrap: 'nowrap' }}>
                        {!isDefault && (
                          <button
                            type="button"
                            className="btn xs"
                            disabled={busy === key}
                            onClick={() =>
                              void act(key, () =>
                                invoke('runtimes:setDefault', runtime.id, version)
                              )
                            }
                          >
                            Set default
                          </button>
                        )}
                        <button
                          type="button"
                          className="btn xs danger"
                          disabled={busy === key}
                          onClick={() =>
                            void act(key, () => invoke('runtimes:uninstall', runtime.id, version))
                          }
                        >
                          Remove
                        </button>
                      </div>
                    </div>
                  )
                })}

                {!runtime.installedVersions.length && (
                  <div className="rt-version">
                    <span className="small muted">No versions installed yet.</span>
                  </div>
                )}
              </div>
            )
          })}
        </div>
      </div>
    </>
  )
}

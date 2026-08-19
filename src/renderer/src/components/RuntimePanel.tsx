import { useState } from 'react'
import type { RuntimeDescriptor } from '../../../shared/runtime.js'
import { invoke } from '../ipc/client.js'

/** Runtimes are installed under ~/.harbor and are invisible to the user's shell. */
export function RuntimePanel({
  runtimes,
  onReload
}: {
  runtimes: RuntimeDescriptor[]
  onReload: () => void
}): React.JSX.Element {
  const [available, setAvailable] = useState<Record<string, string[]>>({})
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  const load = async (id: string): Promise<void> => {
    setError(null)
    try {
      const versions = await invoke('runtimes:available', id)
      setAvailable((prev) => ({ ...prev, [id]: versions.slice(0, 30) }))
    } catch (err) {
      setError((err as Error).message)
    }
  }

  const install = async (id: string, version: string): Promise<void> => {
    setBusy(`${id}@${version}`)
    setError(null)
    try {
      await invoke('runtimes:install', id, version)
      onReload()
    } catch (err) {
      setError((err as Error).message)
    } finally {
      setBusy(null)
    }
  }

  return (
    <section className="runtimes">
      {error && <p className="error">{error}</p>}
      <div className="cards">
        {runtimes.map((runtime) => (
          <article key={runtime.id} className="card">
            <header className="card-head">
              <h3>{runtime.displayName}</h3>
              <span className="badge">{runtime.installedVersions.length} installed</span>
            </header>

            <ul className="plain">
              {runtime.installedVersions.map((v) => (
                <li key={v}>
                  {v}
                  {runtime.defaultVersion === v && <span className="muted small"> (default)</span>}
                </li>
              ))}
              {!runtime.installedVersions.length && <li className="muted">None installed</li>}
            </ul>

            <div className="card-actions">
              <button type="button" className="btn" onClick={() => void load(runtime.id)}>
                Show available
              </button>
            </div>

            {available[runtime.id] && (
              <select
                defaultValue=""
                disabled={busy !== null}
                onChange={(e) => e.target.value && void install(runtime.id, e.target.value)}
              >
                <option value="">Install a version…</option>
                {available[runtime.id]?.map((v) => (
                  <option key={v} value={v}>
                    {v}
                  </option>
                ))}
              </select>
            )}
          </article>
        ))}
      </div>
    </section>
  )
}

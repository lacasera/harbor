import { useEffect, useState } from 'react'
import type { RuntimeConfigFile, RuntimeId } from '../../../shared/runtime.js'
import { invoke } from '../ipc/client.js'

/**
 * Edit a runtime's configuration — `php.ini` and Harbor's own overrides.
 *
 * The files, their paths and what each one affects are all declared by the
 * driver; nothing here knows what PHP is. Saving is by file id, never by path:
 * the renderer has no filesystem access, and sending a path for the main
 * process to write would hand it back.
 */
export function RuntimeConfigEditor({
  runtimeId,
  version,
  onClose
}: {
  runtimeId: RuntimeId
  version: string
  onClose: () => void
}): React.JSX.Element {
  const [files, setFiles] = useState<RuntimeConfigFile[] | null>(null)
  const [selected, setSelected] = useState<string | null>(null)
  const [draft, setDraft] = useState('')
  const [busy, setBusy] = useState(false)
  const [saved, setSaved] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    void invoke('runtimes:configFiles', runtimeId, version)
      .then((result) => {
        if (cancelled) return
        setFiles(result)
        const first = result[0]
        if (first) {
          setSelected(first.id)
          setDraft(first.content)
        }
      })
      .catch((err: Error) => !cancelled && setError(err.message))
    return () => {
      cancelled = true
    }
  }, [runtimeId, version])

  const active = files?.find((f) => f.id === selected) ?? null
  const dirty = active !== null && draft !== active.content

  const pick = (file: RuntimeConfigFile): void => {
    setSelected(file.id)
    setDraft(file.content)
    setSaved(false)
    setError(null)
  }

  const save = async (): Promise<void> => {
    if (!active) return
    setBusy(true)
    setError(null)
    try {
      const next = await invoke('runtimes:writeConfig', runtimeId, version, active.id, draft)
      setFiles(next)
      setDraft(next.find((f) => f.id === active.id)?.content ?? draft)
      setSaved(true)
    } catch (err) {
      setError((err as Error).message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="card" style={{ marginTop: 10 }}>
      <div className="card-head tinted" style={{ padding: '9px 14px' }}>
        <span style={{ fontSize: 12.5, fontWeight: 600 }}>Configuration</span>
        <span className="mono small muted">{version}</span>
        <div className="grow" />
        <button type="button" className="btn xs" onClick={onClose}>
          Close
        </button>
      </div>

      <div className="card-pad">
        {error && <p className="error-text">{error}</p>}
        {!files && <p className="small muted">Loading…</p>}
        {files && !files.length && (
          <p className="small muted">This runtime has no editable configuration.</p>
        )}

        {files && files.length > 0 && (
          <>
            <div className="hstack" style={{ gap: 6, marginBottom: 10, flexWrap: 'wrap' }}>
              {files.map((file) => (
                <button
                  key={file.id}
                  type="button"
                  className={`chip ${selected === file.id ? 'on' : ''}`}
                  onClick={() => pick(file)}
                >
                  <span className="mono">{file.label}</span>
                  {!file.exists && <span className="small muted">new</span>}
                </button>
              ))}
            </div>

            {active && (
              <>
                <div className="hint" style={{ marginBottom: 4 }}>
                  {/* Which processes this file changes. Editing php.ini and
                      editing Harbor's overrides look identical and are not. */}
                  <strong>Affects:</strong> {active.scope}
                </div>
                {active.description && (
                  <div className="hint" style={{ marginBottom: 8 }}>
                    {active.description}
                  </div>
                )}
                <div className="mono small muted" style={{ marginBottom: 8 }}>
                  {active.path}
                </div>

                <textarea
                  className="field-input mono"
                  spellCheck={false}
                  style={{ width: '100%', minHeight: 260, resize: 'vertical', padding: 10 }}
                  value={draft}
                  placeholder={
                    active.owner === 'harbor'
                      ? 'memory_limit = 512M\nupload_max_filesize = 64M'
                      : ''
                  }
                  onChange={(e) => {
                    setDraft(e.target.value)
                    setSaved(false)
                  }}
                />

                <div className="hstack" style={{ gap: 10, marginTop: 10 }}>
                  <button
                    type="button"
                    className="btn primary"
                    disabled={busy || !dirty}
                    onClick={() => void save()}
                  >
                    {busy ? 'Saving…' : 'Save & restart'}
                  </button>
                  <button
                    type="button"
                    className="btn"
                    disabled={busy || !dirty}
                    onClick={() => {
                      setDraft(active.content)
                      setSaved(false)
                    }}
                  >
                    Discard
                  </button>
                  {active.owner === 'system' && (
                    <span className="banner" style={{ color: 'var(--am)' }}>
                      <span className="dot sm" style={{ background: 'var(--am)' }} />
                      shared with your terminal, and replaced on upgrade
                    </span>
                  )}
                  {saved && !dirty && (
                    <span className="banner">
                      <span className="dot sm" style={{ background: 'var(--gn)' }} />
                      saved — the pool was restarted
                    </span>
                  )}
                </div>
              </>
            )}
          </>
        )}
      </div>
    </div>
  )
}

import { useState } from 'react'
import type { ProjectDescriptor } from '../../../shared/project.js'
import { invoke } from '../ipc/client.js'
import { CopyIconButton, StatusDot, useCopy } from './primitives.js'
import { TypeIcon, typeLabel } from './TypeIcon.js'

export function ProjectsView({
  projects,
  parkedDirs,
  onOpen,
  onReload
}: {
  projects: ProjectDescriptor[]
  parkedDirs: string[]
  onOpen: (id: string) => void
  onReload: () => void
}): React.JSX.Element {
  const { copied, copy } = useCopy()
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  // Two-step rather than a modal: removing a project is reversible (re-park
  // it) but silently losing one to a stray click is not acceptable either.
  const [confirming, setConfirming] = useState<string | null>(null)

  const forget = async (id: string): Promise<void> => {
    setBusy(true)
    setError(null)
    try {
      await invoke('projects:forget', id)
      setConfirming(null)
      onReload()
    } catch (err) {
      setError((err as Error).message)
    } finally {
      setBusy(false)
    }
  }

  const pick = async (mode: 'park' | 'link'): Promise<void> => {
    const dir = await invoke('projects:chooseDirectory')
    if (!dir) return
    setBusy(true)
    setError(null)
    try {
      if (mode === 'park') await invoke('projects:park', dir)
      else await invoke('projects:link', dir)
      onReload()
    } catch (err) {
      setError((err as Error).message)
    } finally {
      setBusy(false)
    }
  }

  const running = projects.filter((p) => p.running).length
  const roots = parkedDirs.length ? parkedDirs.join(', ') : 'no parked directories'

  return (
    <>
      <div className="page-head">
        <div>
          <div className="page-title">Projects</div>
          <div className="page-sub">
            {projects.length} parked · {running} running · {roots}
          </div>
        </div>
        <div className="hstack">
          <button type="button" className="btn" disabled={busy} onClick={() => void pick('link')}>
            Link project
          </button>
          <button
            type="button"
            className="btn primary"
            disabled={busy}
            onClick={() => void pick('park')}
          >
            Park directory…
          </button>
        </div>
      </div>

      <div className="page-body" style={{ paddingTop: 16 }}>
        {error && <p className="error-text">{error}</p>}

        {!projects.length ? (
          <div className="empty">
            <div className="glyph">/</div>
            <h3>No projects parked yet</h3>
            <p>
              Park a directory and every folder inside it gets a{' '}
              <span className="mono" style={{ color: 'var(--tx)' }}>
                .test
              </span>{' '}
              domain with TLS. Or link a single project folder.
            </p>
            <div className="actions">
              <button type="button" className="btn primary" onClick={() => void pick('park')}>
                Park directory…
              </button>
              <button type="button" className="btn" onClick={() => void pick('link')}>
                Link project…
              </button>
            </div>
            <div className="foot">
              …or run <span style={{ color: 'var(--tx2)' }}>harbor park ~/Code</span> in a terminal
            </div>
          </div>
        ) : (
          <div className="project-list">
            {projects.map((project) => (
              <div
                key={project.id}
                className="project-row"
                role="button"
                tabIndex={0}
                onClick={() => onOpen(project.id)}
                onKeyDown={(e) => e.key === 'Enter' && onOpen(project.id)}
              >
                <div style={{ minWidth: 0 }}>
                  <div className="name">
                    <StatusDot status={project.running ? 'running' : 'stopped'} />
                    <span>{project.name}</span>
                  </div>
                  <div className="path">{project.path}</div>
                </div>

                <div className="hstack" style={{ gap: 6, flexWrap: 'nowrap', minWidth: 0 }}>
                  <span className="domain">{project.domain}</span>
                  <CopyIconButton
                    text={project.domain}
                    copyKey={`dom-${project.id}`}
                    copied={copied}
                    copy={copy}
                    title="Copy domain"
                  />
                  <a
                    className="icon-btn"
                    href={project.url}
                    target="_blank"
                    rel="noreferrer"
                    title="Open in browser"
                    onClick={(e) => e.stopPropagation()}
                  >
                    ↗
                  </a>
                </div>

                <div>
                  <span className="pill">
                    <TypeIcon
                      frameworkId={project.frameworkId}
                      typeId={project.typeId}
                      size={13}
                    />
                    {typeLabel(project.frameworkId, project.typeId)}
                  </span>
                </div>

                <div className="mono" style={{ fontSize: 11.5, color: 'var(--tx2)' }}>
                  {project.resolvedRuntime
                    ? `${project.resolvedRuntime.runtime} ${project.resolvedRuntime.version}`
                    : '—'}
                </div>

                <div
                  className="mono small"
                  style={{ color: project.secure ? 'var(--gn)' : 'var(--tx3)' }}
                >
                  {project.secure ? 'TLS on' : 'TLS off'}
                </div>

                <div className="row-end">
                  {confirming === project.id ? (
                    <>
                      <button
                        type="button"
                        className="btn xs danger"
                        disabled={busy}
                        onClick={(e) => {
                          e.stopPropagation()
                          void forget(project.id)
                        }}
                      >
                        Remove
                      </button>
                      <button
                        type="button"
                        className="btn xs"
                        onClick={(e) => {
                          e.stopPropagation()
                          setConfirming(null)
                        }}
                      >
                        Cancel
                      </button>
                    </>
                  ) : (
                    <>
                      <button
                        type="button"
                        className="icon-btn forget"
                        title="Remove from Harbor"
                        onClick={(e) => {
                          e.stopPropagation()
                          setConfirming(project.id)
                        }}
                      >
                        ×
                      </button>
                      <span className="chev">›</span>
                    </>
                  )}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </>
  )
}

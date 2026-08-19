import { useState } from 'react'
import type { ProjectDescriptor } from '../../../shared/project.js'
import { invoke } from '../ipc/client.js'

const TYPES = [
  { id: 'php', label: 'PHP' },
  { id: 'node-server', label: 'Node server' },
  { id: 'static', label: 'Static site' }
]

export function ProjectList({
  projects,
  onChanged,
  onReload,
  onInspect
}: {
  projects: ProjectDescriptor[]
  onChanged: (next: ProjectDescriptor) => void
  onReload: () => void
  onInspect: (project: ProjectDescriptor) => void
}): React.JSX.Element {
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  const run = async (id: string, fn: () => Promise<ProjectDescriptor | void>): Promise<void> => {
    setBusy(id)
    setError(null)
    try {
      const next = await fn()
      if (next) onChanged(next)
    } catch (err) {
      setError((err as Error).message)
    } finally {
      setBusy(null)
    }
  }

  const pick = async (mode: 'park' | 'link'): Promise<void> => {
    const dir = await invoke('projects:chooseDirectory')
    if (!dir) return
    setError(null)
    try {
      if (mode === 'park') await invoke('projects:park', dir)
      else await invoke('projects:link', dir)
      onReload()
    } catch (err) {
      setError((err as Error).message)
    }
  }

  return (
    <section className="projects">
      <div className="toolbar">
        <button type="button" className="btn primary" onClick={() => void pick('park')}>
          Park directory
        </button>
        <button type="button" className="btn" onClick={() => void pick('link')}>
          Link project
        </button>
      </div>

      {error && <p className="error">{error}</p>}

      <table className="grid">
        <thead>
          <tr>
            <th>Site</th>
            <th>Type</th>
            <th>Serve</th>
            <th>Runtime</th>
            <th>Port</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {projects.map((project) => (
            <tr key={project.id}>
              <td>
                <a href={project.url} target="_blank" rel="noreferrer">
                  {project.domain}
                </a>
                <div className="muted small">{project.path}</div>
              </td>
              <td>
                <select
                  value={project.typeId}
                  disabled={busy === project.id}
                  onChange={(e) =>
                    void run(project.id, () =>
                      invoke('projects:update', project.id, { typeId: e.target.value })
                    )
                  }
                >
                  {TYPES.map((t) => (
                    <option key={t.id} value={t.id}>
                      {t.label}
                    </option>
                  ))}
                </select>
                {project.frameworkId && <div className="muted small">{project.frameworkId}</div>}
              </td>
              <td>{project.serveModel}</td>
              <td>
                {project.resolvedRuntime ? (
                  <>
                    {project.resolvedRuntime.runtime} {project.resolvedRuntime.version}
                    <div className="muted small">via {project.resolvedRuntime.detail}</div>
                  </>
                ) : (
                  <span className="muted">—</span>
                )}
              </td>
              <td>{project.port ?? '—'}</td>
              <td className="row-actions">
                {project.serveModel === 'reverse-proxy' && (
                  <button
                    type="button"
                    className="btn"
                    disabled={busy === project.id}
                    onClick={() =>
                      void run(project.id, () =>
                        project.running
                          ? invoke('projects:stop', project.id)
                          : invoke('projects:start', project.id)
                      )
                    }
                  >
                    {project.running ? 'Stop' : 'Start'}
                  </button>
                )}
                <button type="button" className="btn ghost" onClick={() => onInspect(project)}>
                  Overview
                </button>
                <button
                  type="button"
                  className="btn ghost"
                  onClick={() =>
                    void invoke('projects:forget', project.id).then(onReload)
                  }
                >
                  Forget
                </button>
              </td>
            </tr>
          ))}
          {!projects.length && (
            <tr>
              <td colSpan={6} className="muted">
                No projects yet — park a directory to serve everything inside it at
                <code> &lt;name&gt;.test</code>.
              </td>
            </tr>
          )}
        </tbody>
      </table>
    </section>
  )
}

import { useEffect, useState } from 'react'
import type { AnalysisResult } from '../../../shared/intelligence.js'
import type { ProjectDescriptor } from '../../../shared/project.js'
import { invoke } from '../ipc/client.js'

/**
 * Static-analysis view. Parsing happens in the main process; this only draws
 * the normalized graph and the Mermaid source it produced.
 */
export function ProjectOverview({
  project,
  onClose
}: {
  project: ProjectDescriptor
  onClose: () => void
}): React.JSX.Element {
  const [results, setResults] = useState<AnalysisResult[] | null>(null)
  const [mermaid, setMermaid] = useState<string>('')
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    setResults(null)
    Promise.all([
      invoke('intelligence:analyze', project.id, false),
      invoke('intelligence:mermaid', project.id, 'erDiagram')
    ])
      .then(([analysis, diagram]) => {
        if (cancelled) return
        setResults(analysis)
        setMermaid(diagram)
      })
      .catch((err: Error) => !cancelled && setError(err.message))
    return () => {
      cancelled = true
    }
  }, [project.id])

  const entities = results?.flatMap((r) => r.entities) ?? []
  const deps = results?.flatMap((r) => r.dependencies.nodes.filter((n) => n.direct)) ?? []
  const warnings = results?.flatMap((r) => r.warnings) ?? []

  return (
    <section className="overview">
      <header className="card-head">
        <h3>{project.name} overview</h3>
        <button type="button" className="btn ghost" onClick={onClose}>
          Close
        </button>
      </header>

      {error && <p className="error">{error}</p>}
      {!results && !error && <p className="muted">Analyzing…</p>}

      {results && (
        <div className="overview-grid">
          <div>
            <h4>Data model ({entities.length})</h4>
            <ul className="plain">
              {entities.map((e) => (
                <li key={e.id}>
                  <strong>{e.name}</strong> <span className="muted">{e.table}</span>
                  <div className="muted small">
                    {e.fields.map((f) => f.name).join(', ') || 'no columns detected'}
                  </div>
                </li>
              ))}
              {!entities.length && <li className="muted">No models detected</li>}
            </ul>
          </div>

          <div>
            <h4>Direct dependencies ({deps.length})</h4>
            <ul className="plain">
              {deps.slice(0, 40).map((d) => (
                <li key={d.id}>
                  {d.name} <span className="muted">{d.version}</span>
                </li>
              ))}
            </ul>
          </div>
        </div>
      )}

      {mermaid && (
        <>
          <h4>ERD (Mermaid)</h4>
          <pre className="mermaid-source">{mermaid}</pre>
        </>
      )}

      {warnings.length > 0 && (
        <details>
          <summary>{warnings.length} analyzer warnings</summary>
          <ul className="plain muted small">
            {warnings.map((w) => (
              <li key={w}>{w}</li>
            ))}
          </ul>
        </details>
      )}
    </section>
  )
}

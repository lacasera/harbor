import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { LogLevel, LogLine } from '../../../shared/logs.js'
import { invoke, subscribe } from '../ipc/client.js'

const LEVELS: LogLevel[] = ['error', 'warn', 'info', 'debug', 'trace', 'unknown']
const MAX_RENDERED = 2000

/**
 * One viewer for every source: services, dev servers, nginx. Dev-server stdout
 * shows up here for free because those processes go through ProcessManager.
 */
export function LogViewer(): React.JSX.Element {
  const [lines, setLines] = useState<LogLine[]>([])
  const [sources, setSources] = useState<string[]>([])
  const [sourceFilter, setSourceFilter] = useState<string>('')
  const [levelFilter, setLevelFilter] = useState<LogLevel | ''>('')
  const [search, setSearch] = useState('')
  const [follow, setFollow] = useState(true)
  const bottom = useRef<HTMLDivElement>(null)

  useEffect(() => {
    void invoke('logs:query', { limit: 500 }).then(setLines)
    void invoke('logs:sources').then(setSources)
  }, [])

  useEffect(
    () =>
      subscribe('log:line', (line) => {
        setLines((prev) => {
          const next = prev.length >= MAX_RENDERED ? prev.slice(-MAX_RENDERED + 1) : prev
          return [...next, line]
        })
        setSources((prev) => (prev.includes(line.source) ? prev : [...prev, line.source]))
      }),
    []
  )

  const visible = useMemo(
    () =>
      lines.filter((l) => {
        if (sourceFilter && l.source !== sourceFilter) return false
        if (levelFilter && l.level !== levelFilter) return false
        if (search && !l.message.toLowerCase().includes(search.toLowerCase())) return false
        return true
      }),
    [lines, sourceFilter, levelFilter, search]
  )

  useEffect(() => {
    if (follow) bottom.current?.scrollIntoView({ block: 'end' })
  }, [visible.length, follow])

  const clear = useCallback(() => {
    void invoke('logs:clear').then(() => setLines([]))
  }, [])

  return (
    <section className="logs">
      <div className="log-toolbar">
        <select value={sourceFilter} onChange={(e) => setSourceFilter(e.target.value)}>
          <option value="">All sources</option>
          {sources.map((s) => (
            <option key={s} value={s}>
              {s}
            </option>
          ))}
        </select>
        <select
          value={levelFilter}
          onChange={(e) => setLevelFilter(e.target.value as LogLevel | '')}
        >
          <option value="">All levels</option>
          {LEVELS.map((l) => (
            <option key={l} value={l}>
              {l}
            </option>
          ))}
        </select>
        <input
          type="search"
          placeholder="Filter…"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
        <label className="inline">
          <input type="checkbox" checked={follow} onChange={(e) => setFollow(e.target.checked)} />
          Follow
        </label>
        <button type="button" className="btn ghost" onClick={clear}>
          Clear
        </button>
      </div>

      <div className="log-stream">
        {visible.map((line) => (
          <div key={line.id} className={`log-line ${line.level}`}>
            <span className="log-time">{new Date(line.timestamp).toLocaleTimeString()}</span>
            <span className="log-source">{line.source}</span>
            <span className="log-msg">{line.message}</span>
          </div>
        ))}
        <div ref={bottom} />
      </div>
    </section>
  )
}

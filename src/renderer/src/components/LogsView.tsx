import { useEffect, useMemo, useRef, useState } from 'react'
import type { LogLevel, LogLine } from '../../../shared/logs.js'
import { invoke } from '../ipc/client.js'
import { formatTime, tintFor } from './primitives.js'

const LEVELS: LogLevel[] = ['info', 'warn', 'error']

/** Shared row renderer — the unified viewer and the per-entity panes agree. */
export function LogRows({
  lines,
  compact
}: {
  lines: LogLine[]
  compact?: boolean
}): React.JSX.Element {
  if (!lines.length) {
    return (
      <div className="log-row">
        <span className="msg muted">No output yet.</span>
      </div>
    )
  }
  return (
    <>
      {lines.map((line) => (
        <div key={line.id} className={`log-row ${line.level}`}>
          <span className="t">{formatTime(line.timestamp)}</span>
          {!compact && (
            <span className="src" title={`${line.source} · ${line.stream}`}>
              <span className="dot sm" style={{ background: tintFor(line.source) }} />
              <span style={{ color: tintFor(line.source) }}>
                {/* A project tails several files; which one matters more than
                    repeating the project name on every row. */}
                {line.stream && line.stream !== 'stdout' && line.stream !== 'stderr'
                  ? line.stream
                  : line.source}
              </span>
            </span>
          )}
          <span className="lvl">{line.level === 'unknown' ? '' : line.level}</span>
          <span className="msg">{line.message}</span>
        </div>
      ))}
    </>
  )
}

export function LogsView({
  lines,
  sources,
  follow,
  onToggleFollow,
  onClear
}: {
  lines: LogLine[]
  sources: string[]
  follow: boolean
  onToggleFollow: () => void
  onClear: () => void
}): React.JSX.Element {
  const [search, setSearch] = useState('')
  const [levels, setLevels] = useState<Record<string, boolean>>({
    info: true,
    warn: true,
    error: true
  })
  const [sourceOff, setSourceOff] = useState<Record<string, boolean>>({})
  const bottom = useRef<HTMLDivElement>(null)

  const visible = useMemo(
    () =>
      lines
        .filter((l) => {
          if (sourceOff[l.source]) return false
          // "unknown" has no chip of its own; it rides along with info.
          if (l.level !== 'unknown' && LEVELS.includes(l.level) && !levels[l.level]) return false
          if (l.level === 'unknown' && !levels.info) return false
          if (search && !`${l.message}${l.source}`.toLowerCase().includes(search.toLowerCase())) {
            return false
          }
          return true
        })
        .slice(-400),
    [lines, sourceOff, levels, search]
  )

  useEffect(() => {
    if (follow) bottom.current?.scrollIntoView({ block: 'end' })
  }, [visible.length, follow])

  const activeSources = sources.filter((s) => !sourceOff[s]).length

  return (
    <>
      <div className="logs-head">
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            gap: 16,
            flexWrap: 'wrap'
          }}
        >
          <div style={{ display: 'flex', alignItems: 'baseline', gap: 10, whiteSpace: 'nowrap' }}>
            <span className="page-title">Logs</span>
            <span className="mono small muted">
              {lines.length} lines buffered · {follow ? 'tailing' : 'paused'} · {activeSources}/
              {sources.length} sources
            </span>
          </div>

          <div className="hstack">
            <div className="search">
              <span className="ring" />
              <input
                type="search"
                placeholder="Search all output…"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
              />
            </div>

            <div className="level-chips">
              {LEVELS.map((lv) => (
                <button
                  key={lv}
                  type="button"
                  className={`${levels[lv] ? 'on' : ''} ${lv}`}
                  onClick={() => setLevels((l) => ({ ...l, [lv]: !l[lv] }))}
                >
                  {lv}
                </button>
              ))}
            </div>

            <button
              type="button"
              className="btn sm"
              style={{
                background: follow ? 'var(--acb)' : 'var(--pn)',
                color: follow ? 'var(--ac)' : 'var(--tx2)'
              }}
              onClick={onToggleFollow}
            >
              {follow ? '❙❙ Following' : '▶ Paused'}
            </button>

            <button type="button" className="btn sm" onClick={onClear}>
              Clear
            </button>
          </div>
        </div>

        <div className="chips">
          {sources.map((source) => {
            const on = !sourceOff[source]
            return (
              <button
                key={source}
                type="button"
                className={`chip ${on ? 'on' : ''}`}
                onClick={() => setSourceOff((s) => ({ ...s, [source]: on }))}
              >
                <span
                  className="dot sm"
                  style={{ background: on ? tintFor(source) : 'var(--tx3)' }}
                />
                {source}
              </button>
            )
          })}
          {!sources.length && <span className="small muted">No sources have emitted yet.</span>}
        </div>
      </div>

      <div className="log-stream">
        <LogRows lines={visible} />
        <div ref={bottom} />
      </div>
    </>
  )
}

export async function clearLogs(): Promise<void> {
  await invoke('logs:clear')
}

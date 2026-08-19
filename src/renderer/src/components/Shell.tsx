import type { Route } from '../routes.js'
import { StatusDot } from './primitives.js'

/** Sidebar icons, drawn as the design specifies: 14px stroked rects. */
const ICONS: Record<string, Array<{ x: number; y: number; w: number; h: number; r: number }>> = {
  projects: [
    { x: 2, y: 2.5, w: 10, h: 3.5, r: 1 },
    { x: 2, y: 8, w: 10, h: 3.5, r: 1 }
  ],
  services: [
    { x: 2, y: 2, w: 4, h: 4, r: 1 },
    { x: 8, y: 2, w: 4, h: 4, r: 1 },
    { x: 2, y: 8, w: 4, h: 4, r: 1 },
    { x: 8, y: 8, w: 4, h: 4, r: 1 }
  ],
  runtimes: [
    { x: 2, y: 3, w: 10, h: 0.1, r: 0 },
    { x: 2, y: 7, w: 7, h: 0.1, r: 0 },
    { x: 2, y: 11, w: 10, h: 0.1, r: 0 }
  ],
  logs: [
    { x: 2, y: 2.5, w: 10, h: 9, r: 1.5 },
    { x: 4.5, y: 6, w: 5, h: 0.1, r: 0 }
  ],
  settings: [
    { x: 4, y: 4, w: 6, h: 6, r: 3 },
    { x: 6.6, y: 6.6, w: 0.8, h: 0.8, r: 0.4 }
  ]
}

function NavIcon({ id }: { id: string }): React.JSX.Element {
  return (
    <svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.4">
      {(ICONS[id] ?? []).map((p, i) => (
        <rect key={i} x={p.x} y={p.y} width={p.w} height={p.h} rx={p.r} />
      ))}
    </svg>
  )
}

export interface RunningEntry {
  id: string
  name: string
  port: string
  go: () => void
}

export function TitleBar({
  runningCount,
  cpu,
  ram,
  theme,
  onToggleTheme
}: {
  runningCount: number
  cpu: string
  ram: string
  theme: 'dark' | 'light'
  onToggleTheme: () => void
}): React.JSX.Element {
  return (
    <div className="titlebar">
      <div className="titlebar-title">
        <b>Harbor</b>
        <span>— Local Development Platform</span>
      </div>
      <div className="titlebar-right">
        <div className="stat-pill">
          <span className="running">
            <StatusDot status={runningCount ? 'running' : 'stopped'} halo={runningCount > 0} />
            {runningCount} running
          </span>
          <span className="divider-v" />
          <span className="metric">CPU {cpu}</span>
          <span className="metric">RAM {ram}</span>
        </div>
        <button
          type="button"
          className="btn sm"
          style={{ display: 'flex', alignItems: 'center', gap: 6, height: 26, padding: '0 9px' }}
          onClick={onToggleTheme}
        >
          <span
            style={{
              width: 9,
              height: 9,
              borderRadius: '50%',
              border: '1.5px solid currentColor'
            }}
          />
          {theme === 'dark' ? 'Dark' : 'Light'}
        </button>
      </div>
    </div>
  )
}

export interface NavCount {
  /** How many exist — what a badge beside a section name should mean. */
  total: number
  /** How many are running — carried by the dot's colour, not the number. */
  running: number
}

export function Sidebar({
  route,
  onNavigate,
  counts,
  running,
  version
}: {
  route: Route
  onNavigate: (route: Route) => void
  counts: { projects: NavCount; services: NavCount }
  running: RunningEntry[]
  version: string
}): React.JSX.Element {
  // Detail routes keep their parent section highlighted.
  const active =
    route.name === 'project' ? 'projects' : route.name === 'service' ? 'services' : route.name

  const items: Array<{ id: Route['name']; label: string; count: NavCount | null }> = [
    { id: 'projects', label: 'Projects', count: counts.projects },
    { id: 'services', label: 'Services', count: counts.services },
    { id: 'runtimes', label: 'Runtimes', count: null },
    { id: 'logs', label: 'Logs', count: null },
    { id: 'settings', label: 'Settings', count: null }
  ]

  return (
    <div className="sidebar">
      <div className="side-label">Workspace</div>
      <div className="nav">
        {items.map((item) => (
          <button
            key={item.id}
            type="button"
            className={`nav-item ${active === item.id ? 'active' : ''}`}
            onClick={() => onNavigate({ name: item.id } as Route)}
          >
            <NavIcon id={item.id} />
            <span className="label">{item.label}</span>
            {item.count !== null && (
              <span
                className="nav-count"
                title={`${item.count.total} total · ${item.count.running} running`}
              >
                {item.count.total}
                <StatusDot status={item.count.running ? 'running' : 'stopped'} small />
              </span>
            )}
          </button>
        ))}
      </div>

      <div className="side-label spaced">Running now</div>
      <div className="running-list">
        {running.map((entry) => (
          <button key={entry.id} type="button" className="running-item" onClick={entry.go}>
            <StatusDot status="running" small />
            <span className="name">{entry.name}</span>
            <span className="port">{entry.port}</span>
          </button>
        ))}
        {!running.length && (
          <div className="running-item" style={{ cursor: 'default', color: 'var(--tx3)' }}>
            <span className="name">Nothing running</span>
          </div>
        )}
      </div>

      <div className="side-spacer" />
      <div className="side-foot">
        <span className="version">v{version}</span>
        <span style={{ color: 'var(--ac)' }}>Up to date</span>
      </div>
    </div>
  )
}

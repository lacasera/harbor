import { useCallback, useEffect, useRef, useState } from 'react'
import type { ServiceHealth } from '../../../shared/service.js'
import type { ProcessHandle, ProcessOwnerKind, ResourceUsage } from '../../../shared/process.js'

/**
 * The recurring pieces the design's component library calls out: one status
 * vocabulary, one toggle, one copy affordance. Every screen composes these
 * rather than restyling its own.
 */

export type Status = 'running' | 'stopped' | 'error' | 'busy'

export function statusOf(health: ServiceHealth): Status {
  if (health === 'running') return 'running'
  if (health === 'starting') return 'busy'
  if (health === 'error' || health === 'unhealthy') return 'error'
  return 'stopped'
}

export function StatusDot({
  status,
  halo,
  small
}: {
  status: Status
  halo?: boolean
  small?: boolean
}): React.JSX.Element {
  const cls = ['dot', status, small ? 'sm' : '', halo ? 'halo' : ''].filter(Boolean).join(' ')
  return <span className={cls} />
}

export function Toggle({
  on,
  onChange,
  label,
  disabled
}: {
  on: boolean
  onChange: (next: boolean) => void
  label: string
  disabled?: boolean
}): React.JSX.Element {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={on}
      aria-label={label}
      disabled={disabled}
      className={`toggle ${on ? 'on' : ''}`}
      onClick={(e) => {
        e.stopPropagation()
        onChange(!on)
      }}
    >
      <span className="knob" />
    </button>
  )
}

/** Idle → copied for 1.6s, matching the design's copy affordance. */
export function useCopy(): { copied: string | null; copy: (text: string, key: string) => void } {
  const [copied, setCopied] = useState<string | null>(null)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current)
    },
    []
  )

  const copy = useCallback((text: string, key: string) => {
    void navigator.clipboard.writeText(text).catch(() => undefined)
    setCopied(key)
    if (timer.current) clearTimeout(timer.current)
    timer.current = setTimeout(() => setCopied(null), 1600)
  }, [])

  return { copied, copy }
}

export function CopyIconButton({
  text,
  copyKey,
  copied,
  copy,
  title
}: {
  text: string
  copyKey: string
  copied: string | null
  copy: (text: string, key: string) => void
  title: string
}): React.JSX.Element {
  const done = copied === copyKey
  return (
    <button
      type="button"
      title={title}
      className={`icon-btn ${done ? 'done' : ''}`}
      onClick={(e) => {
        e.stopPropagation()
        copy(text, copyKey)
      }}
    >
      {done ? '✓' : '⧉'}
    </button>
  )
}

export function Tabs<T extends string>({
  tabs,
  active,
  onSelect
}: {
  tabs: Array<{ id: T; label: string }>
  active: T
  onSelect: (id: T) => void
}): React.JSX.Element {
  return (
    <div className="tabs">
      {tabs.map((t) => (
        <button
          key={t.id}
          type="button"
          className={`tab ${active === t.id ? 'active' : ''}`}
          onClick={() => onSelect(t.id)}
        >
          {t.label}
        </button>
      ))}
    </div>
  )
}

export function Segmented<T extends string>({
  items,
  active,
  onSelect
}: {
  items: Array<{ id: T; label: string }>
  active: T
  onSelect: (id: T) => void
}): React.JSX.Element {
  return (
    <div className="segmented">
      {items.map((i) => (
        <button
          key={i.id}
          type="button"
          className={active === i.id ? 'active' : ''}
          onClick={() => onSelect(i.id)}
        >
          {i.label}
        </button>
      ))}
    </div>
  )
}

/**
 * Deterministic tint per service/project id. The design gives each source a
 * distinct hue; deriving it from the id means a newly registered driver gets a
 * colour without anyone editing a palette map.
 */
export function tintFor(id: string): string {
  let hash = 0
  for (let i = 0; i < id.length; i++) hash = (hash * 31 + id.charCodeAt(i)) >>> 0
  const hue = hash % 360
  return `oklch(0.68 0.15 ${hue})`
}

/**
 * Monograms for the service tiles. A single initial reads best, so a second
 * letter is added only when another service in the catalogue shares that
 * initial — which keeps tiles distinct without a hand-maintained abbreviation
 * table that every new driver would have to be added to.
 */
export function monogramsFor(names: string[]): Map<string, string> {
  const initials = new Map<string, number>()
  for (const name of names) {
    const first = (name[0] ?? '').toUpperCase()
    initials.set(first, (initials.get(first) ?? 0) + 1)
  }
  const out = new Map<string, string>()
  for (const name of names) {
    const first = (name[0] ?? '').toUpperCase()
    const collides = (initials.get(first) ?? 0) > 1
    out.set(name, collides ? first + (name[1] ?? '').toLowerCase() : first)
  }
  return out
}

/**
 * Resource samples are keyed by ProcessManager id, not by owner, so a view has
 * to resolve the owner's live handle first. Doing that in one place stops each
 * screen from inventing its own (wrong) match.
 */
export function processForOwner(
  processes: ProcessHandle[],
  kind: ProcessOwnerKind,
  id: string
): ProcessHandle | undefined {
  return processes.find(
    (p) => p.owner.kind === kind && p.owner.id === id && p.state !== 'stopped'
  )
}

export function usageForOwner(
  processes: ProcessHandle[],
  usage: ResourceUsage[],
  kind: ProcessOwnerKind,
  id: string
): ResourceUsage | undefined {
  const handle = processForOwner(processes, kind, id)
  return handle ? usage.find((u) => u.processId === handle.id) : undefined
}

export function formatBytes(bytes: number): string {
  if (!bytes) return '—'
  const mb = bytes / (1024 * 1024)
  return mb >= 1024 ? `${(mb / 1024).toFixed(1)} GB` : `${Math.round(mb)} MB`
}

export function formatUptime(startedAt: number | null): string {
  if (!startedAt) return '—'
  const secs = Math.floor((Date.now() - startedAt) / 1000)
  const h = Math.floor(secs / 3600)
  const m = Math.floor((secs % 3600) / 60)
  return h ? `${h}h ${String(m).padStart(2, '0')}m` : `${m}m`
}

export function formatTime(ms: number): string {
  const d = new Date(ms)
  const p = (v: number, n = 2): string => String(v).padStart(n, '0')
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}.${p(d.getMilliseconds(), 3)}`
}

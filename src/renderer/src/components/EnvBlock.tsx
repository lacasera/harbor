import type { EnvBlock as EnvBlockData } from '../../../shared/service.js'

/**
 * The design's env-var block: read-only, syntax-highlighted, copy-first.
 * Values are whatever the main process resolved from live config — this
 * component never sees a template.
 */

export interface EnvRow {
  id: string
  n: string
  key: string
  eq: string
  value: string
  comment?: boolean
}

/** Merge several service blocks, dedupe keys, and prefix each with a comment. */
export function toRows(blocks: EnvBlockData[], withHeaders: boolean): EnvRow[] {
  const seen = new Set<string>()
  const rows: EnvRow[] = []
  let n = 1

  for (const block of blocks) {
    let wroteHeader = false
    for (const { key, value } of block.vars) {
      // First writer wins: a key exported by two services appears once.
      if (seen.has(key)) continue
      seen.add(key)
      if (withHeaders && !wroteHeader) {
        rows.push({
          id: `${block.serviceId}-h`,
          n: '',
          key: `# ${block.serviceId}`,
          eq: '',
          value: '',
          comment: true
        })
        wroteHeader = true
      }
      rows.push({ id: `${block.serviceId}-${key}`, n: String(n++), key, eq: '=', value })
    }
  }
  return rows
}

export function toText(blocks: EnvBlockData[]): string {
  return toRows(blocks, true)
    .map((r) => (r.eq ? `${r.key}=${r.value}` : r.key))
    .join('\n')
}

function valueClass(value: string): string {
  if (/^(\d+|true|false|null)$/.test(value)) return 'num'
  if (/^https?:/.test(value)) return 'url'
  return 'str'
}

export function EnvLines({
  rows,
  gutter = true
}: {
  rows: EnvRow[]
  gutter?: boolean
}): React.JSX.Element {
  return (
    <div className="env-block">
      {rows.map((row) =>
        row.comment ? (
          <div key={row.id} className="env-line">
            {gutter && <span className="n" />}
            <span className="env-comment">{row.key}</span>
          </div>
        ) : (
          <div key={row.id} className="env-line">
            {gutter && <span className="n">{row.n}</span>}
            <span className="env-key">{row.key}</span>
            <span className="env-eq">{row.eq}</span>
            <span className={`env-val ${valueClass(row.value)}`}>{row.value}</span>
          </div>
        )
      )}
      {!rows.length && (
        <div className="env-line">
          <span className="env-comment"># no services enabled — nothing to export</span>
        </div>
      )}
    </div>
  )
}

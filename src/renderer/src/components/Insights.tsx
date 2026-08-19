import { useMemo, useState } from 'react'
import type {
  AnalysisResult,
  DependencyNode,
  Entity,
  Relation
} from '../../../shared/intelligence.js'
import type { InsightTab } from '../routes.js'
import { Segmented, tintFor } from './primitives.js'
import { DiagramCanvas, DiagramLegend } from './DiagramCanvas.js'

const BOX_W = 240
const COL_GAP = 360
const ROW_GAP = 190
const COLS = 4

interface Placed extends Entity {
  x: number
  y: number
}

/** Column-major grid on the design's 360×190 lattice. */
function layout(entities: Entity[]): Placed[] {
  return entities.map((entity, i) => ({
    ...entity,
    x: 40 + Math.floor(i / COLS) * COL_GAP,
    y: 40 + (i % COLS) * ROW_GAP
  }))
}

function boxHeight(entity: Entity): number {
  return 30 + Math.min(entity.fields.length, 6) * 22 + 6
}

/** Orthogonal elbow between two boxes — vertical within a column, side-to-side across. */
function edgePath(from: Placed, to: Placed): string {
  const fh = boxHeight(from)
  if (from.x === to.x) {
    const [top, bottom] = from.y < to.y ? [from, to] : [to, from]
    return `M${top.x + BOX_W / 2} ${top.y + boxHeight(top)} V${bottom.y}`
  }
  const leftToRight = from.x < to.x
  const startX = leftToRight ? from.x + BOX_W : from.x
  const endX = leftToRight ? to.x : to.x + BOX_W
  const midX = (startX + endX) / 2
  return `M${startX} ${from.y + fh / 2} H${midX} V${to.y + boxHeight(to) / 2} H${endX}`
}

export function Insights({
  results,
  analyzing,
  onAnalyze
}: {
  results: AnalysisResult[]
  analyzing: boolean
  onAnalyze: () => void
}): React.JSX.Element {
  const [tab, setTab] = useState<InsightTab>('erd')

  const entities = useMemo(() => layout(results.flatMap((r) => r.entities)), [results])
  const relations = useMemo(() => results.flatMap((r) => r.relations), [results])
  const depNodes = useMemo(() => results.flatMap((r) => r.dependencies.nodes), [results])
  const depEdges = useMemo(() => results.flatMap((r) => r.dependencies.edges), [results])

  const meta =
    tab === 'deps'
      ? `${depNodes.length} packages · ${depNodes.filter((n) => n.direct).length} direct`
      : `${entities.length} models · ${relations.length} relations`

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          gap: 16,
          flexWrap: 'wrap'
        }}
      >
        <Segmented
          active={tab}
          onSelect={setTab}
          items={[
            { id: 'erd', label: 'Data models' },
            { id: 'deps', label: 'Dependency tree' },
            { id: 'uml', label: 'UML & structure' }
          ]}
        />
        <div className="hstack">
          <span className="small muted">{meta}</span>
          <button type="button" className="btn sm" disabled={analyzing} onClick={onAnalyze}>
            Re-analyze
          </button>
        </div>
      </div>

      <div className="card">
        {analyzing ? (
          <div className="analyzing">
            <div className="bar">
              <i />
            </div>
            <div className="hstack" style={{ fontSize: 13, fontWeight: 500 }}>
              <span className="dot busy" />
              Analyzing project…
            </div>
            <div className="mono small muted">
              parsing migrations · resolving relations · reading lockfiles
            </div>
          </div>
        ) : tab === 'deps' ? (
          <DepTree nodes={depNodes} edges={depEdges} />
        ) : tab === 'erd' ? (
          <ErdView entities={entities} relations={relations} />
        ) : (
          <UmlView entities={entities} relations={relations} />
        )}
      </div>
    </div>
  )
}

function ErdView({
  entities,
  relations
}: {
  entities: Placed[]
  relations: Relation[]
}): React.JSX.Element {
  const byId = new Map(entities.map((e) => [e.id, e]))
  const width = 40 + Math.max(1, Math.ceil(entities.length / COLS)) * COL_GAP
  const height = 40 + COLS * ROW_GAP

  if (!entities.length) return <EmptyCanvas what="data models" />

  return (
    <DiagramCanvas width={width} height={height} fitZoom={0.72} legend={<DiagramLegend />}>
      <svg width={width} height={height} fill="none" stroke="var(--tx3)" strokeWidth="1.4">
        {relations.map((rel, i) => {
          const from = byId.get(rel.from)
          const to = byId.get(rel.to)
          if (!from || !to) return null
          return (
            <path
              key={i}
              d={edgePath(from, to)}
              strokeDasharray={rel.kind === 'many-to-many' ? '5 4' : undefined}
            />
          )
        })}
      </svg>

      {entities.map((entity) => (
        <div key={entity.id} className="entity" style={{ left: entity.x, top: entity.y }}>
          <div className="head">
            <span className="square" style={{ background: tintFor(entity.name) }} />
            <span className="name">{entity.table ?? entity.name}</span>
            <div className="grow" />
            <span className="small muted" style={{ fontSize: 10 }}>
              {entity.fields.length} cols
            </span>
          </div>
          <div className="fields">
            {entity.fields.slice(0, 6).map((field) => (
              <div key={field.name} className="field">
                <span
                  className={`key ${field.primary ? 'pk' : /_id$/.test(field.name) ? 'fk' : ''}`}
                >
                  {field.primary ? 'PK' : /_id$/.test(field.name) ? 'FK' : ''}
                </span>
                <span className="fname">{field.name}</span>
                <span className="ftype">{field.type}</span>
              </div>
            ))}
          </div>
        </div>
      ))}
    </DiagramCanvas>
  )
}

function UmlView({
  entities,
  relations
}: {
  entities: Placed[]
  relations: Relation[]
}): React.JSX.Element {
  const byId = new Map(entities.map((e) => [e.id, e]))
  const width = 40 + Math.max(1, Math.ceil(entities.length / COLS)) * COL_GAP
  const height = 40 + COLS * ROW_GAP

  if (!entities.length) return <EmptyCanvas what="classes" />

  return (
    <DiagramCanvas width={width} height={height} fitZoom={0.9} legend={<DiagramLegend />}>
      <svg width={width} height={height} fill="none" stroke="var(--tx3)" strokeWidth="1.4">
        {relations.map((rel, i) => {
          const from = byId.get(rel.from)
          const to = byId.get(rel.to)
          if (!from || !to) return null
          return (
            <path
              key={i}
              d={edgePath(from, to)}
              strokeDasharray={rel.kind === 'many-to-many' ? '5 4' : undefined}
            />
          )
        })}
      </svg>

      {entities.map((entity) => (
        <div key={entity.id} className="entity" style={{ left: entity.x, top: entity.y }}>
          <div className="head" style={{ height: 'auto', padding: '8px 11px 7px', display: 'block' }}>
            <div className="mono" style={{ fontSize: 10, color: tintFor(entity.name) }}>
              «model»
            </div>
            <div style={{ fontSize: 12.5, fontWeight: 600, marginTop: 2 }}>{entity.name}</div>
          </div>
          <div className="fields">
            {relations
              .filter((r) => r.from === entity.id)
              .slice(0, 4)
              .map((r, i) => (
                <div key={i} className="field">
                  <span className="fname">{`+ ${r.label ?? r.kind}(): ${r.to}`}</span>
                </div>
              ))}
            {!relations.some((r) => r.from === entity.id) && (
              <div className="field">
                <span className="fname muted">no outgoing relations</span>
              </div>
            )}
          </div>
        </div>
      ))}
    </DiagramCanvas>
  )
}

interface DepRow {
  id: string
  name: string
  version: string
  depth: number
  direct: boolean
  hasChildren: boolean
  expanded: boolean
}

function DepTree({
  nodes,
  edges
}: {
  nodes: DependencyNode[]
  edges: Array<{ from: string; to: string }>
}): React.JSX.Element {
  const [expanded, setExpanded] = useState<Record<string, boolean>>({})

  const { rows, roots, transitive } = useMemo(() => {
    const byId = new Map(nodes.map((n) => [n.id, n]))
    const children = new Map<string, string[]>()
    for (const edge of edges) {
      const list = children.get(edge.from) ?? []
      if (!list.includes(edge.to)) list.push(edge.to)
      children.set(edge.from, list)
    }

    const directs = nodes.filter((n) => n.direct)
    const out: DepRow[] = []

    // Depth-capped walk with a seen-set: lockfile graphs contain cycles, and an
    // uncapped recursion would hang the renderer.
    const walk = (id: string, depth: number, seen: Set<string>): void => {
      const node = byId.get(id)
      if (!node) return
      const kids = (children.get(id) ?? []).filter((k) => !seen.has(k))
      const isOpen = Boolean(expanded[id])
      out.push({
        id,
        name: node.name,
        version: node.version,
        depth,
        direct: node.direct,
        hasChildren: kids.length > 0,
        expanded: isOpen
      })
      if (!isOpen || depth >= 4) return
      for (const kid of kids) walk(kid, depth + 1, new Set([...seen, kid]))
    }

    for (const root of directs) walk(root.id, 0, new Set([root.id]))
    return {
      rows: out,
      roots: directs.length,
      transitive: nodes.length - directs.length
    }
  }, [nodes, edges, expanded])

  if (!nodes.length) {
    return (
      <div className="analyzing">
        <div className="muted">No dependency manifest found in this project.</div>
      </div>
    )
  }

  return (
    <div className="dep-layout">
      <div className="dep-tree">
        {rows.map((row) => (
          <button
            key={`${row.id}-${row.depth}`}
            type="button"
            className={`dep-row ${row.depth ? 'nested' : ''}`}
            style={{ paddingLeft: 14 + row.depth * 22 }}
            onClick={() =>
              row.hasChildren && setExpanded((e) => ({ ...e, [row.id]: !e[row.id] }))
            }
          >
            <span className="caret">{row.hasChildren ? (row.expanded ? '▾' : '▸') : ''}</span>
            <span className={`bullet ${row.direct ? 'direct' : ''}`} />
            <span className={`dname ${row.direct ? 'direct' : ''}`}>{row.name}</span>
            <span className="dv">{row.version}</span>
            <div className="grow" />
          </button>
        ))}
      </div>

      <div className="dep-side">
        <div style={{ fontSize: 12.5, fontWeight: 600, marginBottom: 10 }}>Summary</div>
        {[
          { k: 'Direct', v: String(roots), color: 'var(--ac)' },
          { k: 'Transitive', v: String(transitive), color: 'var(--tx3)' },
          { k: 'Total', v: String(nodes.length), color: 'transparent' }
        ].map((item) => (
          <div key={item.k} className="stat-row">
            <span className="hstack" style={{ gap: 7, fontSize: 12, color: 'var(--tx2)' }}>
              <span className="dot sm" style={{ background: item.color }} />
              {item.k}
            </span>
            <span className="mono" style={{ fontSize: 12 }}>
              {item.v}
            </span>
          </div>
        ))}
        <div className="dep-note">
          The tree is capped at four levels and skips packages already shown on the current
          branch — lockfile graphs contain cycles.
        </div>
      </div>
    </div>
  )
}

function EmptyCanvas({ what }: { what: string }): React.JSX.Element {
  return (
    <div className="analyzing">
      <div className="muted">No {what} detected in this project.</div>
      <div className="mono small muted">
        analyzers run on demand — try Re-analyze after adding models
      </div>
    </div>
  )
}

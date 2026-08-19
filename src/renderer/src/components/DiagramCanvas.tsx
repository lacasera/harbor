import { useCallback, useRef, useState, type ReactNode } from 'react'

/**
 * Shared by the ERD and UML views: dot grid, drag-to-pan, zoom toolbar, fit.
 * The design calls this out as one component precisely so the three diagram
 * types can't drift apart.
 */
export function DiagramCanvas({
  width,
  height,
  fitZoom,
  legend,
  children
}: {
  width: number
  height: number
  fitZoom: number
  legend?: ReactNode
  children: ReactNode
}): React.JSX.Element {
  const [zoom, setZoom] = useState(fitZoom)
  const [pan, setPan] = useState({ x: 12, y: 12 })
  const origin = useRef({ x: 0, y: 0, panX: 0, panY: 0 })

  const startPan = useCallback(
    (e: React.MouseEvent) => {
      origin.current = { x: e.clientX, y: e.clientY, panX: pan.x, panY: pan.y }
      const move = (ev: MouseEvent): void => {
        const o = origin.current
        setPan({ x: o.panX + ev.clientX - o.x, y: o.panY + ev.clientY - o.y })
      }
      const up = (): void => {
        window.removeEventListener('mousemove', move)
        window.removeEventListener('mouseup', up)
      }
      window.addEventListener('mousemove', move)
      window.addEventListener('mouseup', up)
    },
    [pan]
  )

  return (
    <>
      <div className="canvas-toolbar">
        <div className="zoom-group">
          <button type="button" onClick={() => setZoom((z) => Math.max(0.4, z - 0.1))}>
            −
          </button>
          <div className="pct">{Math.round(zoom * 100)}%</div>
          <button type="button" onClick={() => setZoom((z) => Math.min(1.6, z + 0.1))}>
            +
          </button>
        </div>
        <button
          type="button"
          className="btn xs"
          onClick={() => {
            setZoom(fitZoom)
            setPan({ x: 12, y: 12 })
          }}
        >
          Fit to screen
        </button>
        <div className="grow" />
        {legend}
      </div>

      <div className="canvas" onMouseDown={startPan}>
        <div className="grid" />
        <div
          className="surface"
          style={{
            width,
            height,
            transform: `translate(${pan.x}px, ${pan.y}px) scale(${zoom})`
          }}
        >
          {children}
        </div>
      </div>
    </>
  )
}

export function DiagramLegend(): React.JSX.Element {
  return (
    <div className="legend">
      <span>
        <span className="line" />
        one-to-many
      </span>
      <span>
        <span className="line dashed" />
        many-to-many
      </span>
      <span className="mono">drag to pan</span>
    </div>
  )
}

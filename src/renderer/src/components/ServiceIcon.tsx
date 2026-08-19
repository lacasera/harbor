import type { ServiceIconKind } from '../../../shared/service.js'
import { monogramsFor } from './primitives.js'
import { brandLogo } from './brand-logos.js'
import { BrandTile } from './BrandIcon.js'

/**
 * Service tiles.
 *
 * The official mark is used where one is available (see service-logos.ts).
 * Everything else falls back to a category glyph, then to a monogram, so a
 * driver that ships neither a logo nor an icon still renders something
 * legible rather than an empty square.
 */
function Glyph({ kind }: { kind: ServiceIconKind }): React.JSX.Element {
  const stroke = {
    fill: 'none',
    stroke: 'currentColor',
    strokeWidth: 1.7,
    strokeLinecap: 'round' as const,
    strokeLinejoin: 'round' as const
  }

  switch (kind) {
    // Object storage: a bucket.
    case 'storage':
      return (
        <>
          <path d="M3.2 5.2 L4.4 12.4 h5.2 L10.8 5.2" {...stroke} />
          <ellipse cx="7" cy="5" rx="3.9" ry="1.5" {...stroke} />
        </>
      )
    // Search: a magnifier.
    case 'search':
      return (
        <>
          <circle cx="6.3" cy="6.3" r="3.5" {...stroke} />
          <path d="M9 9 L11.8 11.8" {...stroke} />
        </>
      )
    // Queue: messages waiting in line, feeding a consumer.
    case 'queue':
      return (
        <>
          <rect x="2" y="3.4" width="4.4" height="2.6" rx="0.7" {...stroke} />
          <rect x="2" y="8" width="4.4" height="2.6" rx="0.7" {...stroke} />
          <path d="M7.2 4.7 H9.4 a1.4 1.4 0 0 1 1.4 1.4 V9.3 M10.8 9.3 L9.6 8 M10.8 9.3 L12 8" {...stroke} />
        </>
      )
    // Event streaming: a topology of connected nodes.
    case 'stream':
      return (
        <>
          <circle cx="3.4" cy="7" r="1.6" {...stroke} />
          <circle cx="10.6" cy="3.6" r="1.6" {...stroke} />
          <circle cx="10.6" cy="10.4" r="1.6" {...stroke} />
          <path d="M4.9 6.3 L9.1 4.3 M4.9 7.7 L9.1 9.7" {...stroke} />
        </>
      )
    case 'cloud':
      return (
        <path
          d="M4.3 10.6 a2.6 2.6 0 0 1 .2-5.2 A3.3 3.3 0 0 1 11 5.9 a2.4 2.4 0 0 1-.4 4.7 Z"
          {...stroke}
        />
      )
    // Database: the familiar stacked cylinder.
    case 'database':
      return (
        <>
          <ellipse cx="7" cy="3.9" rx="4" ry="1.6" {...stroke} />
          <path d="M3 3.9 V10.1 c0 .9 1.8 1.6 4 1.6 s4-.7 4-1.6 V3.9" {...stroke} />
          <path d="M3 7 c0 .9 1.8 1.6 4 1.6 s4-.7 4-1.6" {...stroke} />
        </>
      )
    // Cache: fast in, fast out.
    case 'cache':
      return (
        <>
          <rect x="2.2" y="3.6" width="9.6" height="6.8" rx="1.4" {...stroke} />
          <path d="M5.4 6 L7.2 7 L5.4 8 M8.4 8 H10" {...stroke} />
        </>
      )
    default:
      return (
        <>
          <rect x="2.4" y="2.4" width="4" height="4" rx="1" {...stroke} />
          <rect x="7.6" y="2.4" width="4" height="4" rx="1" {...stroke} />
          <rect x="2.4" y="7.6" width="4" height="4" rx="1" {...stroke} />
          <rect x="7.6" y="7.6" width="4" height="4" rx="1" {...stroke} />
        </>
      )
  }
}

export function ServiceIcon({
  id,
  displayName,
  icon,
  tint,
  catalogue,
  size = 34
}: {
  id: string
  displayName: string
  icon?: ServiceIconKind
  tint?: string
  /** Every service's name, so a monogram fallback stays unambiguous. */
  catalogue: string[]
  size?: number
}): React.JSX.Element {
  // Official mark → category glyph → monogram. A driver that ships none of
  // them still renders something legible rather than an empty square.
  if (brandLogo(id) || icon) {
    return (
      <BrandTile id={id} size={size} fallbackTint={tint}>
        <svg
          width={Math.round(size * 0.55)}
          height={Math.round(size * 0.55)}
          viewBox="0 0 14 14"
          aria-hidden
        >
          <Glyph kind={icon ?? 'generic'} />
        </svg>
      </BrandTile>
    )
  }

  return (
    <div
      className="brand-tile"
      style={{ width: size, height: size, background: tint ?? 'var(--tx3)', color: '#fff' }}
    >
      {monogramsFor(catalogue).get(displayName) ?? displayName.slice(0, 1)}
    </div>
  )
}

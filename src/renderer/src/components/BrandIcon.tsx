import { brandLogo } from './brand-logos.js'

/**
 * Rendering for the official marks.
 *
 * Brand colours are used as published, except where the published colour is
 * unusable against one of Harbor's themes: Deno and Symfony are pure black,
 * Bun is near-white. Those fall back to the theme's own text colour, which is
 * dark on light and light on dark — so a mark stays true where it can be and
 * legible where it cannot.
 */

/** Rec. 601 luma, which tracks perceived brightness better than a mean. */
function luma(hex: string): number | null {
  const match = /^#([0-9a-f]{6})$/i.exec(hex.trim())
  if (!match?.[1]) return null
  const n = parseInt(match[1], 16)
  return 0.299 * ((n >> 16) & 255) + 0.587 * ((n >> 8) & 255) + 0.114 * (n & 255)
}

/** The brand colour, or the theme's text colour when it would disappear. */
export function contrastSafe(hex: string | undefined): string {
  if (!hex) return 'var(--tx3)'
  const l = luma(hex)
  if (l === null) return hex
  // Too dark vanishes on the dark theme; too light vanishes on the light one.
  return l < 60 || l > 200 ? 'var(--tx)' : hex
}

/** Just the mark, for inline use beside a label. */
export function BrandMark({
  id,
  size = 14
}: {
  id: string
  size?: number
}): React.JSX.Element | null {
  const logo = brandLogo(id)
  if (!logo) return null
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill={contrastSafe(logo.hex)}
      role="img"
      aria-label={logo.title}
      style={{ flex: 'none' }}
    >
      <path d={logo.path} />
    </svg>
  )
}

/**
 * The mark on a tinted tile, for grids and headers. A wash with a matching
 * border rather than a solid block: a grid of saturated squares competes for
 * attention and none of them wins.
 */
export function BrandTile({
  id,
  size = 34,
  fallbackTint,
  children
}: {
  id: string
  size?: number
  /** Used when there is no official mark, e.g. a category glyph's colour. */
  fallbackTint?: string
  /** Rendered when there is no official mark. */
  children?: React.ReactNode
}): React.JSX.Element {
  const logo = brandLogo(id)
  const colour = contrastSafe(logo?.hex ?? fallbackTint)

  return (
    <div
      className="brand-tile"
      title={logo?.title ?? id}
      style={{
        width: size,
        height: size,
        background: `color-mix(in srgb, ${colour} 16%, transparent)`,
        border: `1px solid color-mix(in srgb, ${colour} 38%, transparent)`,
        color: colour
      }}
    >
      {logo ? (
        <svg
          width={Math.round(size * 0.56)}
          height={Math.round(size * 0.56)}
          viewBox="0 0 24 24"
          fill="currentColor"
          role="img"
          aria-label={logo.title}
        >
          <path d={logo.path} />
        </svg>
      ) : (
        children
      )}
    </div>
  )
}

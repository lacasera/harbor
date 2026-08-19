/**
 * Framework and project-type marks.
 *
 * These are simple geometric glyphs in each ecosystem's colour, not the real
 * trademarked logos — recognisable at 14px, and ours to ship. A project's
 * framework driver wins over its broader type, so a Laravel site reads as
 * Laravel rather than generically PHP.
 */

const COLORS: Record<string, string> = {
  laravel: '#FF2D20',
  symfony: '#5A9FD4',
  wordpress: '#21759B',
  plain: '#777BB4',
  php: '#777BB4',
  'node-server': '#3C873A',
  node: '#3C873A',
  bun: '#FBF0DF',
  deno: '#70FFAF',
  go: '#00ADD8',
  static: '#8D97A8'
}

export function typeColor(id: string): string {
  return COLORS[id] ?? 'var(--tx3)'
}

function Glyph({ id, color }: { id: string; color: string }): React.JSX.Element {
  const common = { fill: 'none', stroke: color, strokeWidth: 1.6, strokeLinejoin: 'round' as const }

  switch (id) {
    // Laravel's mark is an angular L; two strokes read as it at small sizes.
    case 'laravel':
      return (
        <>
          <path d="M2 3.2 L2 10.8 L9.5 10.8" {...common} strokeLinecap="round" />
          <path d="M5.2 3.2 L9.6 7.2 L12 4.6" {...common} strokeLinecap="round" />
        </>
      )
    // Symfony: the looping S inside a circle.
    case 'symfony':
      return (
        <>
          <circle cx="7" cy="7" r="5.4" {...common} />
          <path d="M9.2 4.6c-1.6-.8-3 0-2.6 1.2.4 1.3 2.3.9 2.6 2.1.3 1.1-1.1 1.9-2.6 1.3" {...common} strokeLinecap="round" />
        </>
      )
    case 'wordpress':
      return (
        <>
          <circle cx="7" cy="7" r="5.4" {...common} />
          <path d="M3.1 5.2 L5.4 11 L7 6.6 L8.6 11 L10.9 5.2" {...common} strokeLinecap="round" />
        </>
      )
    // Node: the hexagon.
    case 'node-server':
    case 'node':
      return <path d="M7 1.8 L12 4.6 L12 9.4 L7 12.2 L2 9.4 L2 4.6 Z" {...common} />
    case 'bun':
      return (
        <>
          <ellipse cx="7" cy="7.4" rx="5.3" ry="4.4" {...common} />
          <circle cx="5.2" cy="6.4" r="0.7" fill={color} stroke="none" />
          <circle cx="8.8" cy="6.4" r="0.7" fill={color} stroke="none" />
        </>
      )
    case 'deno':
      return (
        <>
          <circle cx="7" cy="7" r="5.4" {...common} />
          <circle cx="5.6" cy="5.8" r="0.9" fill={color} stroke="none" />
        </>
      )
    // Go: the gopher is not reducible; its speed-line mark is.
    case 'go':
      return (
        <>
          <circle cx="7" cy="7" r="4.4" {...common} />
          <path d="M0.8 5.4 H3.6 M0.4 7 H3 M0.8 8.6 H3.6" {...common} strokeLinecap="round" />
        </>
      )
    // Plain PHP: the elephant's silhouette does not survive 14px; the wordmark's
    // rounded lozenge does.
    case 'plain':
    case 'php':
      return (
        <>
          <ellipse cx="7" cy="7" rx="6" ry="3.9" {...common} />
          <path d="M4.4 8.6 L5.3 5.4 M5.3 5.4 h1.1 a0.9 0.9 0 0 1 0 1.8 h-1.1" {...common} strokeLinecap="round" />
          <path d="M8.2 8.6 L9.1 5.4" {...common} strokeLinecap="round" />
        </>
      )
    // Static: a plain document.
    default:
      return (
        <>
          <path d="M3.5 1.8 h4.6 L11 4.7 v7.5 H3.5 Z" {...common} />
          <path d="M8.1 1.8 v3 H11" {...common} />
        </>
      )
  }
}

export function TypeIcon({
  frameworkId,
  typeId,
  size = 14
}: {
  frameworkId?: string | null
  typeId: string
  size?: number
}): React.JSX.Element {
  // The framework driver is the more specific answer when there is one, but
  // "plain" says nothing a reader wants — fall back to the type there.
  const id = frameworkId && frameworkId !== 'plain' ? frameworkId : typeId
  return (
    <svg width={size} height={size} viewBox="0 0 14 14" aria-hidden style={{ flex: 'none' }}>
      <Glyph id={id} color={typeColor(id)} />
    </svg>
  )
}

// Capitalising the id gives "Wordpress" and "Php"; these projects have names.
const LABELS: Record<string, string> = {
  laravel: 'Laravel',
  symfony: 'Symfony',
  wordpress: 'WordPress',
  plain: 'PHP',
  php: 'PHP',
  'node-server': 'Node',
  node: 'Node',
  bun: 'Bun',
  deno: 'Deno',
  go: 'Go',
  static: 'Static'
}

/** Human label for a row: the framework when known, else the project type. */
export function typeLabel(frameworkId: string | null | undefined, typeId: string): string {
  if (frameworkId && frameworkId !== 'plain') {
    return LABELS[frameworkId] ?? frameworkId
  }
  return LABELS[typeId] ?? typeId
}

/**
 * Regenerate src/renderer/src/components/service-logos.ts from Simple Icons.
 *
 *   npm run logos
 *
 * Vendoring rather than fetching at runtime is deliberate: a local development
 * tool that needs a CDN to draw its own icons is broken on a plane.
 */
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'

/** Harbor service id → Simple Icons slug. */
const SLUGS: Record<string, string> = {
  minio: 'minio',
  meilisearch: 'meilisearch',
  rabbitmq: 'rabbitmq',
  elasticsearch: 'elasticsearch',
  opensearch: 'opensearch',
  kafka: 'apachekafka'
}

async function main(): Promise<void> {
  const entries: string[] = []

  for (const [service, slug] of Object.entries(SLUGS)) {
    const res = await fetch(`https://cdn.jsdelivr.net/npm/simple-icons@latest/icons/${slug}.svg`)
    if (!res.ok) {
      console.log(`  skip ${service}: HTTP ${res.status}`)
      continue
    }
    const svg = await res.text()
    const title = /<title>([^<]+)<\/title>/.exec(svg)?.[1] ?? service
    const path = /<path d="([^"]+)"/.exec(svg)?.[1]
    if (!path) {
      console.log(`  skip ${service}: no single path`)
      continue
    }
    entries.push(
      `  ${service}: {\n    title: ${JSON.stringify(title)},\n    path: ${JSON.stringify(path)}\n  },`
    )
    console.log(`  ok   ${service} (${path.length} chars)`)
  }

  const file = join(process.cwd(), 'src/renderer/src/components/service-logos.ts')
  const header = `/**
 * Official service marks, as single-path 24×24 SVGs.
 *
 * Vendored from Simple Icons (https://simple-icons.org, CC0-1.0) rather than
 * fetched at runtime: an app that phones a CDN to draw its own UI breaks
 * offline, which is the one place a local development tool must work.
 *
 * The marks themselves remain the trademarks of their respective owners and
 * are used here to identify those projects. Anything without an official mark
 * available falls back to the category glyph in ServiceIcon.
 *
 * Regenerate with: npm run logos
 */
export interface ServiceLogo {
  title: string
  /** Single path, 24×24 viewBox, filled with the service's tint. */
  path: string
}

export const SERVICE_LOGOS: Record<string, ServiceLogo> = {
`
  writeFileSync(file, `${header}${entries.join('\n')}\n}\n`, 'utf8')
  console.log(`\nwrote ${entries.length} marks to service-logos.ts`)
}

void main()

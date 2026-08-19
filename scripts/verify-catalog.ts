/**
 * Phase 4 check: every registered service exposes coherent metadata, the new
 * native driver installs and runs, and a Docker-backed driver genuinely comes
 * up through compose.
 *
 *   npm run verify:catalog
 *
 * Downloads a binary and pulls a container image on first use.
 */
import { HarborApp } from '../src/main/app.js'
import { validate } from '../src/main/services/registry.js'
import { defaultsFor } from '../src/main/services/registry.js'

const wait = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

const results: Array<[string, boolean, string]> = []
const step = (name: string, ok: boolean, detail = ''): void => {
  results.push([name, ok, detail])
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`)
}

async function main(): Promise<void> {
  const harbor = new HarborApp()
  const descriptors = await harbor.services.describeAll()

  step('catalogue registered', descriptors.length === 13, `${descriptors.length} services`)

  // Metadata contract every driver must satisfy for the generated UI to work.
  for (const d of descriptors) {
    const schemaDefaults = defaultsFor(d.configSchema)
    const problems: string[] = []
    if (!d.displayName) problems.push('no displayName')
    if (!d.defaultPorts.length) problems.push('no defaultPorts')
    if (!Object.keys(d.configSchema.properties ?? {}).length) problems.push('empty schema')
    if (!d.envKeys.length) problems.push('no envHints')
    const invalid = validate(d.configSchema, schemaDefaults)
    if (invalid.length) {
      problems.push(`defaults fail own schema: ${invalid.map((e) => e.field).join(',')}`)
    }
    step(`${d.id}: metadata is coherent`, problems.length === 0, problems.join('; ') || d.backend)
  }

  // Every service must produce a resolvable .env block from its own hints.
  for (const d of descriptors) {
    const block = await harbor.services.envBlock(d.id)
    // Only a leftover placeholder is a bug. An empty value is often the right
    // answer — MAIL_USERNAME= and an unauthenticated Redis both want one.
    const unresolved = block.vars.filter((v) => v.value.includes('${'))
    step(
      `${d.id}: env block resolves`,
      unresolved.length === 0 && block.vars.length > 0,
      unresolved.length ? unresolved.map((v) => v.key).join(',') : `${block.vars.length} vars`
    )
  }

  // ── native: Meilisearch, all the way up ─────────────────────────────────
  const meili = harbor.services.get('meilisearch')
  try {
    if (!(await meili.installedVersions()).length) {
      console.log('  ..   downloading Meilisearch (first run)…')
      await harbor.services.install('meilisearch', 'latest')
    }
    step('meilisearch installed', (await meili.installedVersions()).length > 0)

    await harbor.services.start('meilisearch')
    let health = await meili.healthCheck()
    for (let i = 0; i < 20 && health.health !== 'running'; i++) {
      await wait(500)
      health = await meili.healthCheck()
    }
    step('meilisearch healthy', health.health === 'running', health.detail ?? health.error ?? '')
    step(
      'meilisearch logs reach the aggregator',
      harbor.logs.query({ sources: ['meilisearch'], limit: 20 }).length > 0
    )
  } finally {
    await harbor.services.stop('meilisearch').catch(() => undefined)
  }

  // ── docker: LocalStack, the lightest of the four ────────────────────────
  const available = await harbor.docker.available()
  if (!available.ok) {
    step('docker available', false, available.reason ?? '')
  } else {
    step('docker available', true)
    // One TCP-probed service and one HTTP-probed one: the two readiness paths
    // a Docker driver can take, exercised for real rather than assumed.
    for (const id of ['postgres', 'mailpit']) {
      try {
        console.log(`  ..   starting ${id} (pulls the image on first run)…`)
        await harbor.services.start(id)
      } catch (err) {
        // A port already held by something else is a fact about this machine,
        // not a defect in the driver — and Harbor refusing to start onto it is
        // the behaviour under test elsewhere.
        const message = (err as Error).message
        if (message.includes('is held by')) {
          console.log(`  ..   ${id} skipped: ${message}`)
          continue
        }
        throw err
      }

      try {
        const driver = harbor.services.get(id)

        let health = await driver.healthCheck()
        for (let i = 0; i < 90 && health.health !== 'running'; i++) {
          await wait(1000)
          health = await driver.healthCheck()
        }
        step(`${id} healthy`, health.health === 'running', health.detail ?? health.error ?? '')
        step(
          `${id} logs reach the aggregator`,
          harbor.logs.query({ sources: [id], limit: 20 }).length > 0
        )

        const block = await harbor.services.envBlock(id)
        step(
          `${id} env carries live values`,
          block.vars.every((v) => !v.value.includes('${')),
          block.vars.map((v) => v.key).join(', ')
        )
      } finally {
        await harbor.services.stop(id).catch(() => undefined)
      }
    }
  }

  await harbor.shutdown().catch(() => undefined)

  const failed = results.filter(([, ok]) => !ok).length
  console.log(`\n${results.length - failed}/${results.length} steps passed`)
  process.exit(failed ? 1 : 0)
}

void main()

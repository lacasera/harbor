/**
 * Phase 4 check: every registered service exposes coherent metadata, the new
 * native driver installs and runs, and a Docker-backed driver genuinely comes
 * up through compose.
 *
 *   npm run verify:catalog
 *
 * Downloads a binary and pulls a container image on first use.
 *
 * Everything actionable is now per instance, so this attaches its own under a
 * probe owner and detaches it again — it must not leave a stack behind in the
 * real ~/.harbor, and it must not touch a stack a project owns.
 */
import { HarborApp } from '../src/main/app.js'
import { MACHINE_OWNER, type ServiceInstanceRef } from '../src/shared/service.js'
import { defaultsFor, validate } from '../src/main/services/registry.js'

const wait = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

/** Not a real project, so it can never collide with one the user has parked. */
const PROBE_OWNER = 'verify-catalog-probe'

const results: Array<[string, boolean, string]> = []
const step = (name: string, ok: boolean, detail = ''): void => {
  results.push([name, ok, detail])
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`)
}

async function main(): Promise<void> {
  const harbor = new HarborApp()
  const descriptors = await harbor.services.describeCatalogue()
  const attached: ServiceInstanceRef[] = []

  const attach = async (serviceId: string): Promise<ServiceInstanceRef> => {
    const driver = harbor.catalogue.get(serviceId)
    // Native services stay machine-wide, so their instances belong to `machine`.
    const ref = {
      owner: driver.backend === 'native' ? MACHINE_OWNER : PROBE_OWNER,
      serviceId
    }
    if (!harbor.services.get(ref)) {
      await harbor.services.attach(ref, { autoStart: false })
      attached.push(ref)
    }
    return ref
  }

  try {
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
      const ref = await attach(d.id)
      const block = await harbor.services.envBlock(ref)
      // Only a leftover placeholder is a bug. An empty value is often the right
      // answer — MAIL_USERNAME= and an unauthenticated Redis both want one.
      const unresolved = block.vars.filter((v) => v.value.includes('${'))
      step(
        `${d.id}: env block resolves`,
        unresolved.length === 0 && block.vars.length > 0,
        unresolved.length ? unresolved.map((v) => v.key).join(',') : `${block.vars.length} vars`
      )
    }

    // Every port a service asks for must have been allocated, not defaulted:
    // two instances landing on the same port is the failure this prevents.
    for (const d of descriptors) {
      const ref = { owner: d.backend === 'native' ? MACHINE_OWNER : PROBE_OWNER, serviceId: d.id }
      const instance = harbor.services.get(ref)
      const portFieldNames = Object.entries(d.configSchema.properties ?? {})
        .filter(([, prop]) => prop.format === 'port')
        .map(([key]) => key)
      const missing = portFieldNames.filter((f) => !Number(instance?.values[f]))
      step(
        `${d.id}: every port field is allocated`,
        instance !== null && missing.length === 0,
        missing.length ? `unassigned: ${missing.join(',')}` : portFieldNames.join(',')
      )
    }

    // A console link must point at the port the instance actually bound, not at
    // the service's default — the user can move it, and a link to where it used
    // to be is worse than no link at all.
    const WITH_CONSOLE = ['minio', 'meilisearch', 'rabbitmq', 'mailpit']
    for (const d of descriptors) {
      const ref = { owner: d.backend === 'native' ? MACHINE_OWNER : PROBE_OWNER, serviceId: d.id }
      const instance = harbor.services.get(ref)!
      const console_ = harbor.catalogue.get(d.id).console?.(instance) ?? null
      const expected = WITH_CONSOLE.includes(d.id)
      if (!expected) {
        step(`${d.id}: offers no console`, console_ === null, console_?.url ?? '')
        continue
      }
      const ports = Object.entries(d.configSchema.properties ?? {})
        .filter(([, prop]) => prop.format === 'port')
        .map(([key]) => Number(instance.values[key]))
      const port = Number(new URL(console_?.url ?? 'http://x').port)
      step(
        `${d.id}: console points at a live allocated port`,
        Boolean(console_?.label) && ports.includes(port),
        `${console_?.url ?? '(none)'} — allocated ${ports.join(', ')}`
      )
    }

    // ── native: Meilisearch, all the way up ─────────────────────────────────
    const meili = harbor.catalogue.get('meilisearch')
    const meiliRef = await attach('meilisearch')
    try {
      if (!(await meili.installedVersions()).length) {
        console.log('  ..   downloading Meilisearch (first run)…')
        await harbor.services.install('meilisearch', 'latest')
      }
      step('meilisearch installed', (await meili.installedVersions()).length > 0)

      await harbor.services.start(meiliRef)
      const instance = harbor.services.get(meiliRef)!
      let health = await meili.healthCheck(instance)
      for (let i = 0; i < 20 && health.health !== 'running'; i++) {
        await wait(500)
        health = await meili.healthCheck(instance)
      }
      step('meilisearch healthy', health.health === 'running', health.detail ?? health.error ?? '')
      let meiliLines = 0
      for (let i = 0; i < 20 && meiliLines === 0; i++) {
        meiliLines = harbor.logs.query({ sources: ['machine:meilisearch'], limit: 20 }).length
        if (!meiliLines) await wait(500)
      }
      step('meilisearch logs reach the aggregator', meiliLines > 0, `${meiliLines} lines`)
    } finally {
      await harbor.services.stop(meiliRef).catch(() => undefined)
    }

    // ── docker: two readiness paths, exercised for real ─────────────────────
    const available = await harbor.docker.available()
    if (!available.ok) {
      step('docker available', false, available.reason ?? '')
    } else {
      step('docker available', true)
      // One TCP-probed service and one HTTP-probed one: the two readiness paths
      // a Docker driver can take, exercised for real rather than assumed.
      for (const id of ['postgres', 'mailpit']) {
        const ref = { owner: PROBE_OWNER, serviceId: id }
        try {
          console.log(`  ..   starting ${id} (pulls the image on first run)…`)
          await harbor.services.start(ref)
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
          const driver = harbor.catalogue.get(id)
          const instance = harbor.services.get(ref)!

          let health = await driver.healthCheck(instance)
          for (let i = 0; i < 90 && health.health !== 'running'; i++) {
            await wait(1000)
            health = await driver.healthCheck(instance)
          }
          step(`${id} healthy`, health.health === 'running', health.detail ?? health.error ?? '')

          // Polled, not sampled once. `docker compose logs -f` is a separate
          // process and its first output can land after the service is already
          // accepting connections — so a single check passed only when an image
          // pull happened to slow the start down enough.
          let lines = 0
          for (let i = 0; i < 30 && lines === 0; i++) {
            lines = harbor.logs.query({ sources: [`${PROBE_OWNER}:${id}`], limit: 20 }).length
            if (!lines) await wait(500)
          }
          step(`${id} logs reach the aggregator`, lines > 0, `${lines} lines`)

          const block = await harbor.services.envBlock(ref)
          step(
            `${id} env carries live values`,
            block.vars.every((v) => !v.value.includes('${')),
            block.vars.map((v) => v.key).join(', ')
          )
        } finally {
          await harbor.services.stop(ref).catch(() => undefined)
        }
      }
    }
  } finally {
    // Detach every instance this script created, and remove the probe stack —
    // volumes included, since nothing but this script ever wrote to them.
    for (const ref of attached) {
      await harbor.services.detach(ref).catch(() => undefined)
    }
    await harbor.docker
      .down(harbor.projects.composeProjectFor(PROBE_OWNER), { volumes: true })
      .catch(() => undefined)
    // Deliberately not `harbor.shutdown()`: it calls `services.stopAll()`, which
    // stops every instance on the machine — including ones the user is running
    // and this script never touched. Flushing and exiting kills this process's
    // own children and leaves containers alone.
    harbor.store.flush()
  }

  const failed = results.filter(([, ok]) => !ok).length
  console.log(`\n${results.length - failed}/${results.length} steps passed`)
  process.exit(failed ? 1 : 0)
}

void main()

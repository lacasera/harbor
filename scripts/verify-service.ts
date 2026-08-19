/**
 * Phase 2 integration check for the service half of the slice: install MinIO
 * through its driver, start it, prove it is healthy on the ports it actually
 * bound, and that its .env block carries live values rather than schema
 * defaults.
 *
 *   npm run verify:service
 *
 * Runs against the real ~/.harbor and downloads the MinIO binary on first use.
 */
import { HarborApp } from '../src/main/app.js'
import type { ServiceConfig } from '../src/shared/service.js'

const wait = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

const results: Array<[string, boolean, string]> = []
const step = (name: string, ok: boolean, detail = ''): void => {
  results.push([name, ok, detail])
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`)
}

async function main(): Promise<void> {
  const harbor = new HarborApp()
  const driver = harbor.services.get('minio')
  let previous: ServiceConfig | null = null

  try {
    previous = harbor.services.configFor('minio')

    // Non-default ports and credentials on purpose: this is what proves the
    // .env block reflects the running instance instead of the schema.
    await harbor.services.updateConfig('minio', {
      values: {
        ...previous.values,
        port: 9077,
        consolePort: 9078,
        rootUser: 'harbor-probe',
        rootPassword: 'probe-secret-123'
      }
    })

    let installed = await driver.installedVersions()
    if (!installed.length) {
      console.log('  ..   downloading MinIO (first run)…')
      await harbor.services.install('minio', 'latest')
      installed = await driver.installedVersions()
    }
    step('MinIO installed', installed.length > 0, installed.join(', '))

    const started = await harbor.services.start('minio')
    step('start returned a descriptor', Boolean(started))

    // Health polls a real HTTP endpoint, so give the server a moment to bind.
    let health = started.status
    for (let i = 0; i < 20 && health.health !== 'running'; i++) {
      await wait(500)
      health = await driver.healthCheck()
    }
    step('health check reports running', health.health === 'running', health.detail ?? health.error ?? '')
    step('bound the configured ports', health.ports.includes(9077), health.ports.join(', '))

    const block = await harbor.services.envBlock('minio')
    const vars = Object.fromEntries(block.vars.map((v) => [v.key, v.value]))
    step(
      'env block carries live credentials, not schema defaults',
      vars.AWS_ACCESS_KEY_ID === 'harbor-probe' && vars.AWS_SECRET_ACCESS_KEY === 'probe-secret-123',
      `${vars.AWS_ACCESS_KEY_ID}`
    )
    step(
      'env endpoint carries the live port',
      vars.AWS_ENDPOINT === 'http://127.0.0.1:9077',
      vars.AWS_ENDPOINT ?? '(missing)'
    )

    const logs = harbor.logs.query({ sources: ['minio'], limit: 50 })
    step('MinIO output reached the log aggregator', logs.length > 0, `${logs.length} lines`)

    const usage = await harbor.processes.sampleUsage()
    const handle = harbor.processes.findByOwner('service', 'minio')
    step(
      'resource sample resolves via the owner handle',
      Boolean(handle && usage.some((u) => u.processId === handle.id)),
      handle ? `pid ${handle.pid}` : 'no handle'
    )

    const stopped = await harbor.services.stop('minio')
    step('stop reports it stopped', stopped.status.health === 'stopped', stopped.status.health)

    // ── validation ────────────────────────────────────────────────────────
    const invalid = await harbor.services.updateConfig('minio', {
      values: { ...previous.values, port: 80 }
    })
    step(
      'an out-of-range port is rejected against the driver schema',
      !invalid.ok && invalid.errors.some((e) => e.field === 'port'),
      invalid.ok ? 'accepted!' : invalid.errors.map((e) => `${e.field} ${e.message}`).join(', ')
    )
    step(
      'a rejected update leaves the stored config untouched',
      harbor.services.configFor('minio').values.port !== 80,
      `port=${harbor.services.configFor('minio').values.port}`
    )

    // ── crash reporting ───────────────────────────────────────────────────
    await harbor.services.start('minio')
    await wait(1500)
    const live = harbor.processes.findByOwner('service', 'minio')
    if (live?.pid) {
      process.kill(live.pid, 'SIGKILL')
      await wait(1200)
      const after = await harbor.services.describe('minio', { fresh: true })
      step(
        'a killed service reports an error, not merely stopped',
        after.status.health === 'error',
        `${after.status.health}: ${after.status.error ?? ''}`
      )
    } else {
      step('a killed service reports an error, not merely stopped', false, 'no live process')
    }
  } finally {
    if (previous) {
      await harbor.services.updateConfig('minio', { values: previous.values }).catch(() => undefined)
    }
    await harbor.shutdown().catch(() => undefined)
  }

  const failed = results.filter(([, ok]) => !ok).length
  console.log(`\n${results.length - failed}/${results.length} steps passed`)
  process.exit(failed ? 1 : 0)
}

void main()

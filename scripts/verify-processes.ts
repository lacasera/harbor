/**
 * Companion processes — queue workers, schedulers, asset builds — against a
 * real project: detected, startable, logged under their own stream, and never
 * mistaken for the site's own process.
 *
 *   npm run verify:processes
 *
 * Restores every choice it changes. Skips cleanly with no fpm project parked.
 */
import { HarborApp } from '../src/main/app.js'
process.env.HARBOR_NO_PROMPT = '1'
const wait = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

const results: Array<[string, boolean, string]> = []
const step = (n: string, ok: boolean, d = ''): void => {
  results.push([n, ok, d]); console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${n}${d ? ` — ${d}` : ''}`)
}

void (async () => {
  const harbor = new HarborApp()
  const project = harbor.projects.list().find((p) => p.serveModel === 'fpm')
  if (!project) {
    console.log('  ..   no fpm project parked; skipping')
    process.exit(0)
  }
  if (!(await harbor.projects.describeProcesses(project)).some((p) => p.id === 'queue')) {
    console.log('  ..   this project has no queue worker to exercise; skipping')
    process.exit(0)
  }

  try {
    const before = await harbor.projects.describeProcesses(project)
    step('companions detected', before.length > 0, before.map((p) => p.id).join(', '))

    // Start the queue worker: cheap, harmless, and the canonical case.
    await harbor.projects.startProcess(project.id, 'queue')
    await wait(2500)

    const after = (await harbor.projects.describeProcesses(project)).find((p) => p.id === 'queue')
    step('queue worker running', Boolean(after?.running), `pid ${after?.pid}`)

    const lines = harbor.logs.query({ sources: [project.id], limit: 200 })
    const queueLines = lines.filter((l) => l.stream === 'queue')
    step(
      'its output is tagged under the project as its own stream',
      queueLines.length > 0,
      queueLines[0]?.message.slice(0, 60) ?? 'no output yet (worker may be idle)'
    )

    // The site's own status must not be confused by a companion.
    const descriptor = await harbor.projects.describe(project)
    step(
      'a companion does not masquerade as the site process',
      descriptor.running === false && descriptor.served === true,
      `running=${descriptor.running} served=${descriptor.served} by=${descriptor.servedBy}`
    )

    // Disabling stops it immediately.
    await harbor.projects.updateProcess(project.id, 'queue', { enabled: false })
    await wait(1200)
    const stopped = (await harbor.projects.describeProcesses(project)).find((p) => p.id === 'queue')
    step('disabling stops it', stopped?.running === false, `state=${stopped?.state}`)
    step('the choice is persisted', stopped?.enabled === false)

    // ── custom commands ───────────────────────────────────────────────────
    const added = await harbor.projects.addProcess(project.id, {
      label: 'Harbor probe',
      command: 'php artisan --version',
      runtime: 'php'
    })
    const custom = added.processes.find((p) => p.custom)
    step('a custom command can be added', Boolean(custom), custom?.command ?? '')
    step(
      'its id cannot shadow a detected one',
      custom?.id.startsWith('custom:') === true,
      custom?.id ?? ''
    )
    step('custom entries are distinguishable', custom?.custom === true)

    if (custom) {
      await harbor.projects.startProcess(project.id, custom.id)
      await wait(2500)
      const ran = harbor.logs
        .query({ sources: [project.id], limit: 200 })
        .filter((l) => l.stream === custom.id)
      step(
        'a one-off command runs and its output is captured',
        ran.length > 0,
        ran[0]?.message.slice(0, 50) ?? 'no output'
      )

      const after = await harbor.projects.removeProcess(project.id, custom.id)
      step(
        'removing it leaves the detected ones alone',
        !after.processes.some((p) => p.custom) && after.processes.length === before.length,
        `${after.processes.length} remain`
      )
    }
  } finally {
    await harbor.projects.stopAllProcesses(project.id).catch(() => undefined)
    // Restore Harbor's own recommendation rather than leaving it switched off.
    await harbor.projects.updateProcess(project.id, 'queue', { enabled: true }).catch(() => undefined)
    harbor.store.flush()
  }

  const failed = results.filter(([, ok]) => !ok).length
  console.log(`\n${results.length - failed}/${results.length} passed`)
  process.exit(failed ? 1 : 0)
})()

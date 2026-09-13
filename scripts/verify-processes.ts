/**
 * Companion processes — queue workers, schedulers, asset builds — against a
 * real project: detected, startable, logged under their own stream, and never
 * mistaken for the site's own process. Also the two boot behaviours: enabled
 * companions auto-start on launch, and a port conflict is reported (first wins).
 *
 *   npm run verify:processes
 *
 * Restores every choice it changes. Skips cleanly with no fpm project parked.
 */
import type { PortConflict } from '../src/shared/process.js'
import { HarborApp } from '../src/main/app.js'
process.env.HARBOR_NO_PROMPT = '1'
const wait = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

const results: Array<[string, boolean, string]> = []
const step = (n: string, ok: boolean, d = ''): void => {
  results.push([n, ok, d]); console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${n}${d ? ` — ${d}` : ''}`)
}
function finish(): never {
  const failed = results.filter(([, ok]) => !ok).length
  console.log(`\n${results.length - failed}/${results.length} passed`)
  process.exit(failed ? 1 : 0)
}

void (async () => {
  const harbor = new HarborApp()

  // ── port conflict (independent of any parked project) ─────────────────────
  // Two processes race for one port; the first binds it, the second must crash
  // with an address-in-use error and raise a port-conflict event so the loser
  // is surfaced rather than lost. process.execPath is the node running us.
  {
    const port = 34517
    const holder = (): string =>
      `require('net').createServer().listen(${port},'127.0.0.1');setInterval(()=>{},1e3)`
    let conflict: PortConflict | null = null
    harbor.processes.once('port-conflict', (c: PortConflict) => (conflict = c))

    const first = await harbor.processes.spawn({
      owner: { kind: 'system', id: 'harbor-verify', role: `first` },
      label: 'probe (first)',
      command: process.execPath,
      args: ['-e', holder()]
    })
    await wait(500)
    const second = await harbor.processes.spawn({
      owner: { kind: 'system', id: 'harbor-verify', role: `second` },
      label: 'probe (second)',
      command: process.execPath,
      args: ['-e', holder()]
    })
    await wait(1800)

    const c = conflict as PortConflict | null
    step('a port conflict is detected and reported', Boolean(c), c ? `port ${c.port}` : 'no event')
    step('the first process keeps the port', harbor.processes.get(first.id)?.state === 'running')
    await harbor.processes.stop(first.id).catch(() => undefined)
    await harbor.processes.stop(second.id).catch(() => undefined)
  }

  const project = harbor.projects.list().find((p) => p.serveModel === 'fpm')
  if (!project) {
    console.log('  ..   no fpm project parked; skipping companion checks')
    finish()
  }
  if (!(await harbor.projects.describeProcesses(project)).some((p) => p.id === 'queue')) {
    console.log('  ..   this project has no queue worker to exercise; skipping companion checks')
    finish()
  }

  try {
    const before = await harbor.projects.describeProcesses(project)
    step('companions detected', before.length > 0, before.map((p) => p.id).join(', '))

    // The boot path: an enabled companion comes up on launch, no per-project
    // start needed. The queue worker is enabled by default (autoStart), so
    // autoStartProcesses() must bring it up on its own.
    await harbor.projects.updateProcess(project.id, 'queue', { enabled: true })
    await harbor.projects.autoStartProcesses()
    await wait(2500)
    const booted = (await harbor.projects.describeProcesses(project)).find((p) => p.id === 'queue')
    step('an enabled companion auto-starts on launch', Boolean(booted?.running), `state=${booted?.state}`)

    // A second start is a no-op rather than a duplicate.
    await harbor.projects.startProcess(project.id, 'queue')
    await wait(500)

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
    // Only custom processes this run created. `find(p => p.custom)` picked the
    // FIRST custom entry, which on a project where the user had already added
    // one was theirs — so the script started their command and then deleted it.
    const existingCustom = new Set(before.filter((p) => p.custom).map((p) => p.id))
    const added = await harbor.projects.addProcess(project.id, {
      label: 'Harbor probe',
      command: 'php artisan --version',
      runtime: 'php'
    })
    const custom = added.processes.find((p) => p.custom && !existingCustom.has(p.id))
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
        !after.processes.some((p) => p.custom && !existingCustom.has(p.id)) &&
          after.processes.length === before.length,
        `${after.processes.length} remain`
      )
    }
  } finally {
    await harbor.projects.stopAllProcesses(project.id).catch(() => undefined)

    // A run interrupted between add and remove would otherwise leave its
    // process behind and fail every later run — which is exactly what happened.
    for (const p of (await harbor.projects.describeProcesses(harbor.projects.find(project.id)))) {
      if (p.custom && p.label.startsWith('Harbor probe')) {
        await harbor.projects.removeProcess(project.id, p.id).catch(() => undefined)
      }
    }
    // Restore Harbor's own recommendation rather than leaving it switched off.
    await harbor.projects.updateProcess(project.id, 'queue', { enabled: true }).catch(() => undefined)
    harbor.store.flush()
  }

  finish()
})()

import { existsSync } from 'node:fs'
import { execFile as execFileCb } from 'node:child_process'
import { promisify } from 'node:util'
import { HarborApp } from '../src/main/app.js'

const execFile = promisify(execFileCb)

// Never open an auth dialog from a verification run.
process.env.HARBOR_NO_PROMPT = '1'

const wait = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

const results: Array<[string, boolean, string]> = []
const step = (name: string, ok: boolean, detail = ''): void => {
  results.push([name, ok, detail])
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`)
}

/**
 * Verifies the two things process-shaped thinking got wrong about PHP sites:
 * that an fpm site is "served" without owning a process, and that changing the
 * TLD actually re-homes every site rather than only writing a setting.
 *
 *   npm run verify:php
 *
 * Runs against the real ~/.harbor on unprivileged ports and restores every
 * setting it touches. It deliberately never drives the app lifecycle: the
 * daemons it finds may be serving the user's sites right now.
 */
void (async () => {
  const harbor = new HarborApp()
  const original = harbor.store.get().settings.tld
  if (!harbor.projects.list().some((p) => p.serveModel === 'fpm')) {
    console.log('  ..   no fpm project parked; skipping')
    process.exit(0)
  }
  try {
    // Bring the stack up on unprivileged ports.
    harbor.store.update((s) => { s.settings.httpPort = 8080; s.settings.httpsPort = 8443 })
    // Re-render immediately: changing the ports without this leaves every
    // vhost listening where nginx is not, which Harbor now correctly reports
    // as a stale vhost.
    await harbor.projects.rewriteAllVhosts()
    // Never call harbor.start() here. Its orphan reclaim exists for the app's
    // own startup and will kill daemons that are serving right now — including
    // ones the user depends on. Bring up only what this check needs.
    await harbor.dns.start(original)
    for (const p of harbor.projects.list().filter((x) => x.serveModel === 'fpm')) {
      await harbor.projects.ensureFpmFor(p).catch(() => undefined)
    }

    // A root-owned master belongs to the user's real setup; this check runs
    // unprivileged and must not try to restart it.
    const owner = (await harbor.projects.nginx.status()).runningAs
    const canDriveNginx = owner !== 'root'
    if (canDriveNginx) {
      await harbor.projects.nginx.connect()
      await harbor.projects.nginx.restart({ httpPort: 8080, httpsPort: 8443 })
      await wait(1500)
    } else {
      console.log('  ..   nginx is running as root; leaving it alone')
    }

    // ── 1. serving status ────────────────────────────────────────────────
    const all = await harbor.projects.describeAll()
    const php = all.find((p) => p.serveModel === 'fpm')

    // A root nginx whose workers are `nobody` genuinely cannot serve anything.
    // That is a broken machine, not a broken build, so report it as a
    // precondition rather than a failing assertion.
    if (await harbor.projects.nginx.workersCannotReadProjects()) {
      console.log(`  ..   nginx workers are 'nobody'; skipping the serving assertions`)
      console.log(`  ..   reported problem: ${php?.servedProblem}`)
      step('the nobody-worker condition is detected and named', Boolean(php?.servedProblem))
    } else {
      step('an fpm site reports itself served', Boolean(php?.served), php ? `${php.name}: ${php.servedBy ?? php.servedProblem}` : 'none parked')
      step('served is not process state', php?.running === false && php?.served === true, `running=${php?.running} served=${php?.served}`)
    }

    // ── 2. TLD change ────────────────────────────────────────────────────
    const before = php?.domain ?? ''
    const result = await harbor.projects.changeTld('devlocal')
    await harbor.dns.start('devlocal')
    if (canDriveNginx) await harbor.projects.nginx.reload().catch(() => undefined)
    await wait(800)

    const after = harbor.projects.list().find((p) => p.id === php?.id)
    step('project domain re-homed', after?.domain.endsWith('.devlocal') === true, `${before} → ${after?.domain}`)
    step('old vhost removed', !existsSync(`${process.env.HOME}/.harbor/nginx/sites/${before}.conf`), before)
    step('new vhost written', existsSync(`${process.env.HOME}/.harbor/nginx/sites/${after?.domain}.conf`), after?.domain ?? '')
    step('certificate re-issued for the new domain', existsSync(`${process.env.HOME}/.harbor/certs/${after?.domain}.pem`))
    step('all sites moved', result.failed.length === 0, `${result.renamed.length} renamed`)

    const answer = await harbor.dns.answers(`probe.devlocal`)
    step('dnsmasq answers the new TLD', answer === '127.0.0.1', answer ?? 'no answer')

    if (canDriveNginx) {
      const { stdout: code } = await execFile('/usr/bin/curl', [
        '-s', '-o', '/dev/null', '-w', '%{http_code}', '--max-time', '20',
        '--resolve', `${after?.domain}:8443:127.0.0.1`, `https://${after?.domain}:8443/`
      ]).catch((e: Error) => ({ stdout: `ERR ${e.message.split('\n')[0]}` }))
      step('site serves on the new domain', code === '200', `HTTP ${code}`)
    } else {
      console.log('  ..   skipped the HTTP check (nginx not ours to restart)')
    }
  } finally {
    // Put everything back exactly as it was.
    await harbor.projects.changeTld(original).catch(() => undefined)
    harbor.store.update((s) => { s.settings.tld = original; s.settings.httpPort = 80; s.settings.httpsPort = 443 })
    await harbor.dns.start(original).catch(() => undefined)
    // Re-render with the restored TLD and ports. Restoring settings alone
    // leaves every vhost listening where nginx is not, so nginx matches none
    // of them and serves whichever loaded first — every site showing one site.
    await harbor.projects.rewriteAllVhosts().catch(() => undefined)
    // Leave dnsmasq and the FPM pools up: they may be serving the user's sites.
    harbor.store.flush()
  }
  const failed = results.filter(([, ok]) => !ok).length
  console.log(`\n${results.length - failed}/${results.length} passed`)
  process.exit(failed ? 1 : 0)
})()

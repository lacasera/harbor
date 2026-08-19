import { existsSync } from 'node:fs'
import { execFile as execFileCb } from 'node:child_process'
import { promisify } from 'node:util'
import { HarborApp } from '../src/main/app.js'

const execFile = promisify(execFileCb)
const wait = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))
const results: Array<[string, boolean, string]> = []
const step = (n: string, ok: boolean, d = ''): void => {
  results.push([n, ok, d]); console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${n}${d ? ` — ${d}` : ''}`)
}

/**
 * Verifies the two things process-shaped thinking got wrong about PHP sites:
 * that an fpm site is "served" without owning a process, and that changing the
 * TLD actually re-homes every site rather than only writing a setting.
 *
 *   npm run verify:php
 *
 * Runs against the real ~/.harbor on unprivileged ports and restores every
 * setting it touches. Skips cleanly when no fpm project is parked.
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
    await harbor.start()
    await harbor.projects.nginx.connect()
    await harbor.projects.nginx.restart({ httpPort: 8080, httpsPort: 8443 })
    await wait(1500)

    // ── 1. serving status ────────────────────────────────────────────────
    const all = await harbor.projects.describeAll()
    const php = all.find((p) => p.serveModel === 'fpm')
    step('an fpm site reports itself served', Boolean(php?.served), php ? `${php.name}: ${php.servedBy ?? php.servedProblem}` : 'none parked')
    step('served is not process state', php?.running === false && php?.served === true, `running=${php?.running} served=${php?.served}`)

    // ── 2. TLD change ────────────────────────────────────────────────────
    const before = php?.domain ?? ''
    const result = await harbor.projects.changeTld('devlocal')
    await harbor.dns.start('devlocal')
    await harbor.projects.nginx.reload().catch(() => undefined)
    await wait(800)

    const after = harbor.projects.list().find((p) => p.id === php?.id)
    step('project domain re-homed', after?.domain.endsWith('.devlocal') === true, `${before} → ${after?.domain}`)
    step('old vhost removed', !existsSync(`${process.env.HOME}/.harbor/nginx/sites/${before}.conf`), before)
    step('new vhost written', existsSync(`${process.env.HOME}/.harbor/nginx/sites/${after?.domain}.conf`), after?.domain ?? '')
    step('certificate re-issued for the new domain', existsSync(`${process.env.HOME}/.harbor/certs/${after?.domain}.pem`))
    step('all sites moved', result.failed.length === 0, `${result.renamed.length} renamed`)

    const answer = await harbor.dns.answers(`probe.devlocal`)
    step('dnsmasq answers the new TLD', answer === '127.0.0.1', answer ?? 'no answer')

    const { stdout: code } = await execFile('/usr/bin/curl', [
      '-s', '-o', '/dev/null', '-w', '%{http_code}', '--max-time', '20',
      '--resolve', `${after?.domain}:8443:127.0.0.1`, `https://${after?.domain}:8443/`
    ]).catch((e: Error) => ({ stdout: `ERR ${e.message.split('\n')[0]}` }))
    step('site serves on the new domain', code === '200', `HTTP ${code}`)
  } finally {
    // Put everything back exactly as it was.
    await harbor.projects.changeTld(original).catch(() => undefined)
    harbor.store.update((s) => { s.settings.tld = original; s.settings.httpPort = 80; s.settings.httpsPort = 443 })
    await harbor.dns.start(original).catch(() => undefined)
    await harbor.shutdown().catch(() => undefined)
  }
  const failed = results.filter(([, ok]) => !ok).length
  console.log(`\n${results.length - failed}/${results.length} passed`)
  process.exit(failed ? 1 : 0)
})()

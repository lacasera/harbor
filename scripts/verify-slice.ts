/**
 * Phase 2 integration check: park a real project, serve it through the system
 * nginx, and prove a request reaches it.
 *
 * Runs against the real ~/.harbor and the real nginx, so it is opt-in:
 *   npm run verify:slice
 *
 * DNS is deliberately not exercised — resolving `*.test` needs a root-written
 * /etc/resolver file. Requests are sent with an explicit Host header, which
 * verifies everything up to and including nginx's server_name routing.
 */
import { execFile as execFileCb, execFileSync, spawn } from 'node:child_process'
import { promisify } from 'node:util'
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { HarborApp } from '../src/main/app.js'
import { isFree } from '../src/main/core/port-allocator.js'

const execFile = promisify(execFileCb)

// Never open an auth dialog from a verification run.
process.env.HARBOR_NO_PROMPT = '1'

/**
 * LIVE HARBOR: these run against the real ~/.harbor. If the app is open, its
 * daemons are serving the user's sites and must not be restarted or stopped
 * from here.
 */
function harborIsRunning(): boolean {
  try {
    return (
      execFileSync('/bin/ps', ['-Ao', 'args='], { encoding: 'utf8' })
        .split('\n')
        .some((l) => /Harbor\.app\/Contents\/MacOS\/Harbor|electron .*out\/main/.test(l))
    )
  } catch {
    return false
  }
}
const NGINX = '/opt/homebrew/bin/nginx'

/**
 * Don't assume a port is ours. A process bound to 127.0.0.1:8080 beats nginx's
 * *:8080 for loopback connections, which makes the check silently talk to
 * whatever else is running.
 */
async function freePort(): Promise<number> {
  for (let port = 8080; port < 8200; port++) {
    if (await isFree(port, '127.0.0.1')) return port
  }
  throw new Error('no free port for the nginx front door')
}

const wait = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

function makeExpressApp(): string {
  const dir = mkdtempSync(join(tmpdir(), 'harbor-slice-'))
  mkdirSync(dir, { recursive: true })
  writeFileSync(
    join(dir, 'package.json'),
    JSON.stringify(
      { name: 'slice-api', version: '1.0.0', scripts: { dev: 'node server.js' } },
      null,
      2
    )
  )
  // No dependencies: node's own http server is enough to prove the proxy path.
  writeFileSync(
    join(dir, 'server.js'),
    `const http = require('http')
const port = process.env.PORT || 3000
http.createServer((req, res) => {
  console.log('handled ' + req.method + ' ' + req.url)
  res.writeHead(200, { 'content-type': 'text/plain' })
  res.end('harbor-slice-ok port=' + port)
}).listen(port, '127.0.0.1', () => console.log('listening on ' + port))
`
  )
  return dir
}

async function nginxRunning(): Promise<boolean> {
  return execFile('/usr/bin/pgrep', ['-x', 'nginx'])
    .then(() => true)
    .catch(() => false)
}

const results: Array<[string, boolean, string]> = []
const step = (name: string, ok: boolean, detail = ''): void => {
  results.push([name, ok, detail])
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`)
}

async function main(): Promise<void> {
  if (harborIsRunning()) {
    console.log('  ..   Harbor is running; skipping (it owns the daemons this would restart)')
    process.exit(0)
  }
  const harbor = new HarborApp()
  const dir = makeExpressApp()
  const HTTP_PORT = await freePort()
  console.log(`  ..   using :${HTTP_PORT} for the nginx front door`)
  let projectId: string | null = null
  let previousPorts: { httpPort: number; httpsPort: number } | null = null

  try {
    // Unprivileged ports so the whole chain runs without a password prompt.
    // Restored in the finally block — this runs against the user's real
    // ~/.harbor and must not leave their front-door ports rewritten.
    previousPorts = {
      httpPort: harbor.store.get().settings.httpPort,
      httpsPort: harbor.store.get().settings.httpsPort
    }
    harbor.store.update((s) => {
      s.settings.httpPort = HTTP_PORT
      s.settings.httpsPort = 8443
    })

    // Always a fresh temp directory, so this never adopts a real project —
    // asserted rather than assumed.
    if (harbor.projects.list().some((p) => p.path === dir)) {
      throw new Error('refusing to run: the scratch path is already a parked project')
    }
    const project = await harbor.projects.link(dir)
    projectId = project.id
    step(
      'project detected as a reverse-proxy node server',
      project.typeId === 'node-server' && project.serveModel === 'reverse-proxy',
      `${project.typeId}/${project.serveModel}`
    )
    step('port allocated and persisted', typeof project.port === 'number', `:${project.port}`)

    const started = await harbor.projects.start(project.id)
    step('dev server spawned', started.running, started.resolvedStartCommand ?? '')

    // Regenerate every vhost and drop orphans first: nginx validates the whole
    // config at once, so one stale file would fail the connect for all sites.
    const swept = await harbor.projects.rewriteAllVhosts()
    step(
      'vhosts regenerated and orphans swept',
      swept.failed.length === 0,
      `${swept.written} written, ${swept.removed} removed`
    )

    // A root-owned master belongs to the user's real setup — it serves :80/:443
    // and restarting it needs a password. This check runs unprivileged, so it
    // verifies everything up to nginx and says plainly what it skipped.
    const owner = (await harbor.projects.nginx.status()).runningAs
    const canDriveNginx = owner !== 'root'
    if (!canDriveNginx) {
      console.log('  ..   nginx is running as root; skipping the steps that restart it')
      step('vhost rendered for the site', Boolean(harbor.projects.nginx.read(started)))
      const test = await harbor.projects.nginx.test()
      step('nginx accepts the generated config', test.ok, test.output.trim().split('\n').pop() ?? '')
      const lines = harbor.logs.query({ sources: [project.id], limit: 50 })
      step(
        'dev-server output reached the log aggregator',
        lines.some((l) => l.message.includes('listening on')),
        `${lines.length} lines`
      )
      return
    }

    // The vhost is rendered on park; connect nginx so it is actually read.
    await harbor.projects.nginx.connect()
    step(
      'nginx connected',
      harbor.projects.nginx.isConnected(),
      harbor.projects.nginx.strategy() ?? ''
    )

    const test = await harbor.projects.nginx.test()
    step('nginx accepts the generated config', test.ok, test.output.trim().split('\n').pop() ?? '')

    // Restart nginx so it picks up the new listen port, not just reloads.
    if (await nginxRunning()) {
      await execFile(NGINX, ['-s', 'stop']).catch(() => undefined)
      await wait(800)
    }
    spawn(NGINX, [], { detached: true, stdio: 'ignore' }).unref()
    await wait(1200)
    step('nginx running', await nginxRunning())

    // Give the dev server a moment to bind before proxying to it.
    await wait(1500)

    const { stdout } = await execFile('/usr/bin/curl', [
      '-s',
      '--max-time',
      '10',
      '-H',
      `Host: ${started.domain}`,
      `http://127.0.0.1:${HTTP_PORT}/`
    ])
    step(
      `request to ${started.domain} reaches the app through nginx`,
      stdout.includes('harbor-slice-ok'),
      stdout.trim().slice(0, 60)
    )
    step(
      'proxied to the allocated port',
      stdout.includes(`port=${started.port}`),
      `expected port=${started.port}`
    )

    // Dev-server stdout must land in the aggregator for free.
    const lines = harbor.logs.query({ sources: [project.id], limit: 50 })
    step(
      'dev-server output reached the log aggregator',
      lines.some((l) => l.message.includes('listening on')),
      `${lines.length} lines`
    )

    // ── DNS ───────────────────────────────────────────────────────────────
    // dnsmasq runs unprivileged, so this is fully checkable. Only the
    // /etc/resolver file needs root, and it is one line naming this port.
    const tld = harbor.store.get().settings.tld
    await harbor.dns.start(tld)

    const answer = await harbor.dns.answers(`harbor-probe.${tld}`)
    step(`dnsmasq resolves *.${tld} to 127.0.0.1`, answer === '127.0.0.1', answer ?? 'no answer')

    const dns = await harbor.dns.status(tld)
    step('dnsmasq managed by ProcessManager', dns.running, `port ${dns.port}`)
    step(
      `/etc/resolver/${tld} written`,
      dns.resolverConfigured,
      dns.resolverConfigured ? '' : 'needs one root prompt — run it from Settings'
    )

    const dnsLogs = harbor.logs.query({ sources: ['dnsmasq'], limit: 20 })
    step('dnsmasq logs reach the aggregator', dnsLogs.length > 0, `${dnsLogs.length} lines`)

    // ── TLS ───────────────────────────────────────────────────────────────
    const secured = await harbor.projects.update(project.id, { secure: true })
    step('certificate issued for the site', secured.secure && secured.url.startsWith('https://'))

    await execFile(NGINX, ['-s', 'reload']).catch(() => undefined)
    await wait(800)

    // /usr/bin/curl uses Secure Transport, so this proves the CA is actually
    // trusted by the system rather than merely present on disk.
    const https = await execFile('/usr/bin/curl', [
      '-s',
      '--max-time',
      '10',
      '--resolve',
      `${secured.domain}:8443:127.0.0.1`,
      `https://${secured.domain}:8443/`
    ]).catch((err: Error) => ({ stdout: `ERR ${err.message.split('\n')[0]}` }))
    step(
      'HTTPS served with a trusted local certificate',
      https.stdout.includes('harbor-slice-ok'),
      https.stdout.trim().slice(0, 70)
    )
  } finally {
    if (projectId) await harbor.projects.forget(projectId).catch(() => undefined)
    if (previousPorts) {
      const restore = previousPorts
      harbor.store.update((s) => {
        s.settings.httpPort = restore.httpPort
        s.settings.httpsPort = restore.httpsPort
      })
      // Re-render with the restored ports; settings alone leave every vhost
      // listening where nginx is not.
      await harbor.projects.rewriteAllVhosts().catch(() => undefined)
    }
    await harbor.shutdown().catch(() => undefined)
    rmSync(dir, { recursive: true, force: true })
  }

  const failed = results.filter(([, ok]) => !ok).length
  console.log(`\n${results.length - failed}/${results.length} steps passed`)
  process.exit(failed ? 1 : 0)
}

void main()

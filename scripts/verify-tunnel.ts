/**
 * Verification for driver-based public tunnels.
 *
 *   npm run verify:tunnel
 *
 * Deliberately self-contained: it never constructs HarborApp and never touches
 * the live ~/.harbor, because that state is the captain's working environment.
 * It builds the tunnel pieces directly with fakes and a local stand-in origin.
 *
 * What it proves, per the brief:
 *   1. The sharp edge — the tunnel preserves the project's hostname to the
 *      origin, so nginx serves the right project and not the catch-all vhost.
 *   2. A missing provider binary is offered an install rather than erroring.
 *   3. An unauthenticated provider explains exactly what is missing.
 *   4. A killed tunnel restarts, and the restart notification carries the NEW
 *      public URL (the ephemeral case that silently breaks the old one).
 *
 * Honest gap: ngrok has no authtoken on this machine and modern ngrok needs one
 * even for an ephemeral tunnel, so the ngrok end-to-end path is NOT exercised —
 * only its capability reporting and its argv are checked. cloudflared's own
 * end-to-end run needs the public internet and is likewise not driven here; the
 * hostname-preservation semantics it depends on are proved against a local
 * stand-in for nginx instead.
 */
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import type { Notice } from '../src/shared/notice.js'
import { ProcessManager } from '../src/main/core/process-manager.js'
import { Notifier } from '../src/main/core/notifier.js'
import { CloudflaredDriver } from '../src/main/tunnels/cloudflared.js'
import { NgrokDriver } from '../src/main/tunnels/ngrok.js'
import { TunnelProviders } from '../src/main/tunnels/registry.js'
import { TunnelManager } from '../src/main/tunnels/manager.js'
import type { TunnelDriver, TunnelOrigin, TunnelSpawnPlan } from '../src/main/tunnels/types.js'
import type { TunnelCapability } from '../src/shared/tunnel.js'

const wait = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

const results: Array<[string, boolean, string]> = []
const step = (name: string, ok: boolean, detail = ''): void => {
  results.push([name, ok, detail])
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`)
}

/** The value cloudflared/ngrok pass right after a flag. */
const after = (args: string[], flag: string): string | undefined => {
  const i = args.indexOf(flag)
  return i >= 0 ? args[i + 1] : undefined
}

async function waitFor(cond: () => boolean, ms: number): Promise<boolean> {
  const end = Date.now() + ms
  while (Date.now() < end) {
    if (cond()) return true
    await wait(50)
  }
  return cond()
}

/** A GET that reaches the stand-in origin with whatever Host header we choose. */
function get(port: number, host: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path: '/', headers: { Host: host } }, (res) => {
      let body = ''
      res.setEncoding('utf8')
      res.on('data', (c) => (body += c))
      res.on('end', () => resolve(body))
    })
    req.on('error', reject)
    req.end()
  })
}

/**
 * A fake provider that spawns a real process which prints a fresh URL each run
 * and then stays alive — so an ephemeral restart genuinely yields a different
 * URL, which is the case the restart notification has to carry.
 */
class FakeDriver implements TunnelDriver {
  readonly id = 'fake'
  readonly displayName = 'Fake'
  runs = 0
  binary(): string | null {
    return process.execPath
  }
  async install(): Promise<void> {}
  async probe(): Promise<TunnelCapability> {
    return {
      provider: this.id,
      displayName: this.displayName,
      installed: true,
      authenticated: true,
      hostname: 'ephemeral'
    }
  }
  plan(_origin: TunnelOrigin): TunnelSpawnPlan {
    this.runs += 1
    const url = `https://run-${this.runs}.example.test`
    const script = `process.stdout.write(${JSON.stringify(`tunnel url ${url}\n`)});setInterval(()=>{},1e9)`
    return { command: process.execPath, args: ['-e', script] }
  }
  parseUrl(line: string): string | null {
    return /tunnel url (\S+)/.exec(line)?.[1] ?? null
  }
}

/** A provider that reports itself uninstalled, to exercise the install offer. */
class MissingDriver extends FakeDriver {
  override binary(): null {
    return null
  }
  override async probe(): Promise<TunnelCapability> {
    return {
      provider: 'fake',
      displayName: 'Fake',
      installed: false,
      authenticated: false,
      hostname: 'unknown'
    }
  }
}

async function main(): Promise<void> {
  // ── 1. the sharp edge: cloudflared preserves the project hostname ─────────
  const native = { which: () => '/opt/homebrew/bin/cloudflared', brewPrefix: () => '/opt/homebrew' }
  const cf = new CloudflaredDriver(native as never)

  const secure = cf.plan({ domain: 'admin-app.test', host: '127.0.0.1', port: 443, secure: true })
  step(
    'secured tunnel forwards to the https origin',
    after(secure.args, '--url') === 'https://127.0.0.1:443',
    after(secure.args, '--url') ?? '(none)'
  )
  step(
    'secured tunnel sets the Host header to the project domain',
    after(secure.args, '--http-host-header') === 'admin-app.test',
    after(secure.args, '--http-host-header') ?? '(none)'
  )
  step(
    'secured tunnel sets the TLS SNI to the project domain',
    after(secure.args, '--origin-server-name') === 'admin-app.test',
    after(secure.args, '--origin-server-name') ?? '(none)'
  )
  step(
    "secured tunnel tolerates Harbor's own certificate",
    secure.args.includes('--no-tls-verify')
  )

  const plain = cf.plan({ domain: 'blog.test', host: '127.0.0.1', port: 80, secure: false })
  step(
    'plain tunnel forwards to the http origin with the Host header',
    after(plain.args, '--url') === 'http://127.0.0.1:80' &&
      after(plain.args, '--http-host-header') === 'blog.test'
  )
  step(
    'plain tunnel does not add TLS-origin flags',
    !plain.args.includes('--no-tls-verify') && !plain.args.includes('--origin-server-name')
  )

  // The semantics the argv encodes, proved against a stand-in for nginx: a
  // request carrying the project's Host header reaches its vhost; one without it
  // (the naive loopback host) falls through to the catch-all — which is exactly
  // the silent wrong-project bug the hostname preservation exists to prevent.
  const origin = http.createServer((req, res) => {
    const host = (req.headers.host ?? '').split(':')[0]
    res.end(host === 'admin-app.test' ? 'admin-app' : host === 'api.test' ? 'api' : 'CATCH-ALL')
  })
  await new Promise<void>((r) => origin.listen(0, '127.0.0.1', () => r()))
  const originPort = (origin.address() as AddressInfo).port
  try {
    const withHost = await get(originPort, 'admin-app.test')
    const naive = await get(originPort, `127.0.0.1:${originPort}`)
    step('the preserved Host header selects the project vhost', withHost === 'admin-app', withHost)
    step(
      'without the Host header nginx would serve the catch-all',
      naive === 'CATCH-ALL',
      naive
    )
  } finally {
    origin.close()
  }

  // ── 2. a missing binary is offered an install, not a bare error ───────────
  {
    const providers = new TunnelProviders()
    providers.register(new MissingDriver())
    const mgr = tunnelManager(providers, new ProcessManager({} as never), new Notifier())
    let offered = false
    try {
      await mgr.start('p1')
    } catch (err) {
      offered = (err as { needsInstall?: string }).needsInstall === 'fake'
    }
    step('starting an uninstalled provider offers to install it', offered)
  }

  // Same fact at the driver level: with no binary found anywhere, probe reports
  // not-installed (so the UI shows an Install button) rather than throwing.
  {
    const savedPath = process.env.PATH
    process.env.PATH = ''
    const cap = await new CloudflaredDriver({ which: () => null } as never).probe()
    process.env.PATH = savedPath
    step('cloudflared reports itself uninstalled when absent', !cap.installed, cap.detail ?? '')
  }

  // ── 3. an unauthenticated provider explains itself ────────────────────────
  {
    const ngrok = new NgrokDriver({ which: () => '/opt/homebrew/bin/ngrok' } as never)
    const cap = await ngrok.probe()
    step(
      'ngrok reports installed-but-unauthenticated with a concrete hint',
      cap.installed && !cap.authenticated && /authtoken/i.test(cap.authHint ?? ''),
      cap.authHint ?? '(no hint)'
    )
  }

  // ── 4. a killed tunnel restarts and the notice carries the NEW URL ────────
  {
    const providers = new TunnelProviders()
    const fake = new FakeDriver()
    providers.register(fake)
    const processes = new ProcessManager({} as never)
    const notifier = new Notifier()
    const notices: Notice[] = []
    notifier.on('notice', (n: Notice) => notices.push(n))
    const mgr = tunnelManager(providers, processes, notifier, { backoffBaseMs: 50, backoffMaxMs: 100 })

    const started = await mgr.start('p1')
    step('tunnel captured a public URL on start', Boolean(started.url), started.url ?? '(none)')

    const handle = processes.findByOwner('project', 'p1', false, 'tunnel')
    if (handle?.pid) process.kill(handle.pid, 'SIGKILL')

    const changed = await waitFor(() => {
      const t = mgr.activeList()[0]
      return Boolean(t?.url && t.url !== started.url)
    }, 8000)
    const now = mgr.activeList()[0]
    step('a killed tunnel restarts on its own', changed && (now?.restarts ?? 0) >= 1, `${now?.restarts ?? 0} restart(s)`)
    step(
      'the restart issued a different ephemeral URL',
      Boolean(now?.url && now.url !== started.url),
      now?.url ?? '(none)'
    )
    step(
      'the restart notification carries the new URL',
      notices.some((n) => Boolean(now?.url) && (n.message ?? '').includes(now?.url ?? ' ') && /restart|new url/i.test(n.title)),
      notices.map((n) => n.title).join(' | ')
    )

    await mgr.stopAll()
    step('stopAll leaves nothing exposed', mgr.activeList().length === 0)
    // Cleanup any child the fake left running.
    await processes.stopAll()
  }

  const failed = results.filter(([, ok]) => !ok).length
  console.log(`\n${results.length - failed}/${results.length} steps passed`)
  process.exit(failed ? 1 : 0)
}

/** A TunnelManager wired for the tests: a fake store and log sink, no disk. */
function tunnelManager(
  providers: TunnelProviders,
  processes: ProcessManager,
  notifier: Notifier,
  options: { backoffBaseMs?: number; backoffMaxMs?: number } = {}
): TunnelManager {
  const store = {
    get: () => ({ settings: { tunnelProvider: 'fake', httpPort: 80, httpsPort: 443 } })
  }
  const logs = { push: () => undefined }
  const resolve = (id: string): { name: string; domain: string; secure: boolean } | null =>
    id === 'p1' ? { name: 'admin-app', domain: 'admin-app.test', secure: true } : null
  return new TunnelManager(providers, processes, notifier, logs as never, store as never, resolve, {
    urlTimeoutMs: 5000,
    stableMs: 100_000,
    ...options
  })
}

void main()

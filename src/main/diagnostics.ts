import { execFile as execFileCb } from 'node:child_process'
import { promisify } from 'node:util'
import type { Diagnostic } from '../shared/diagnostics.js'
import type { HarborApp } from './app.js'
import { cliStatus } from './cli/install.js'

const execFile = promisify(execFileCb)

/** Tools Harbor shells out to, and what stops working without each. */
const TOOLS: Array<{ bin: string; needed: string; install: string; required: boolean }> = [
  { bin: 'brew', needed: 'installing PHP, nginx and dnsmasq', install: 'https://brew.sh', required: true },
  { bin: 'nginx', needed: 'serving every site', install: 'brew install nginx', required: true },
  { bin: 'dnsmasq', needed: 'resolving .test domains', install: 'brew install dnsmasq', required: false },
  { bin: 'mkcert', needed: 'trusted HTTPS', install: 'brew install mkcert', required: false },
]

async function which(bin: string): Promise<string | null> {
  return execFile('/usr/bin/which', [bin])
    .then((r) => r.stdout.trim() || null)
    .catch(() => null)
}

/**
 * Everything Harbor depends on, checked in one pass.
 *
 * Run at startup and from Settings. The point is that a broken installation
 * says so: the app can look perfectly healthy while every site 502s and every
 * service refuses to start, and the errors it produces then describe symptoms
 * rather than the cause — "No Docker daemon" when the real problem was that a
 * GUI-launched app cannot see `/usr/local/bin`.
 */
export async function runDiagnostics(harbor: HarborApp): Promise<Diagnostic[]> {
  const out: Diagnostic[] = []

  // ── the tools themselves ────────────────────────────────────────────────
  const found = new Map<string, string | null>()
  for (const tool of TOOLS) found.set(tool.bin, await which(tool.bin))

  const missing = TOOLS.filter((t) => !found.get(t.bin))
  out.push({
    id: 'path',
    label: 'Command line tools',
    status: missing.some((t) => t.required) ? 'fail' : missing.length ? 'warn' : 'ok',
    detail: missing.length
      ? `not found: ${missing.map((t) => t.bin).join(', ')}`
      : `${TOOLS.length} of ${TOOLS.length} found`,
    // The commonest cause by far, and invisible from inside the app: launchd
    // gives a Finder-launched app `/usr/bin:/bin:/usr/sbin:/sbin` and nothing
    // more, so tools that are installed are simply not on PATH.
    remedy: missing.length
      ? `Install: ${missing.map((t) => t.install).join(' · ')}`
      : undefined,
    required: missing.some((t) => t.required)
  })

  for (const tool of TOOLS) {
    const path = found.get(tool.bin)
    if (path) continue
    out.push({
      id: `tool:${tool.bin}`,
      label: tool.bin,
      status: tool.required ? 'fail' : 'warn',
      detail: `not found — needed for ${tool.needed}`,
      remedy: tool.install,
      required: tool.required
    })
  }

  // ── serving ─────────────────────────────────────────────────────────────
  const nginx = await harbor.projects.nginx.status().catch(() => null)
  if (nginx?.installed) {
    const problems: string[] = []
    if (!nginx.connected) problems.push('not reading Harbor\'s vhosts')
    if (!nginx.running) problems.push('not running')
    if (nginx.workerUser === 'nobody') problems.push('workers run as nobody and cannot read your projects')
    out.push({
      id: 'nginx',
      label: 'nginx',
      status: problems.length ? 'fail' : 'ok',
      detail: problems.length
        ? problems.join('; ')
        : `running as ${nginx.runningAs ?? 'unknown'} on :${nginx.listening.join(', ') || '—'}`,
      remedy: problems.length ? 'Connect and restart nginx from Settings' : undefined,
      required: true
    })

    const test = await harbor.projects.nginx.test().catch(() => null)
    if (test && !test.syntaxOk) {
      out.push({
        id: 'nginx-config',
        label: 'nginx configuration',
        status: 'fail',
        // The failure mode this exists for: nginx keeps serving the last config
        // it loaded, so a rejected one is invisible — new sites simply never
        // appear and the catch-all answers them.
        detail: test.output.trim().split('\n').slice(-2).join(' '),
        remedy: 'Fix the reported file; nginx is still serving its last valid config',
        required: true
      })
    }
  }

  const dns = await harbor.dns.status(harbor.store.get().settings.tld).catch(() => null)
  if (dns) {
    const ok = dns.installed && dns.running && dns.resolverConfigured && dns.resolves
    out.push({
      id: 'dns',
      label: 'Local DNS',
      status: ok ? 'ok' : dns.installed ? 'warn' : 'warn',
      detail: !dns.installed
        ? 'dnsmasq is not installed'
        : !dns.running
          ? 'dnsmasq is not running'
          : !dns.resolverConfigured
            ? '/etc/resolver is not configured'
            : dns.resolves
              ? `answering on :${dns.port}`
              : 'running but not answering',
      remedy: ok ? undefined : 'Set up local DNS from Settings',
      required: false
    })
  }

  const tls = await harbor.tls.status().catch(() => null)
  if (tls) {
    out.push({
      id: 'tls',
      label: 'Local certificates',
      status: tls.installed && tls.caInstalled ? 'ok' : 'warn',
      detail: !tls.installed
        ? 'mkcert is not installed'
        : tls.caInstalled
          ? 'local CA is trusted'
          : 'local CA is not trusted by this machine',
      remedy: tls.installed && !tls.caInstalled ? 'Trust the local CA from Settings' : undefined,
      required: false
    })
  }

  // ── runtimes and services ───────────────────────────────────────────────
  const php = await harbor.runtimes.get('php').installedVersions().catch(() => [])
  out.push({
    id: 'php',
    label: 'PHP',
    status: php.length ? 'ok' : 'warn',
    detail: php.length ? `${php.join(', ')} installed` : 'no versions installed',
    remedy: php.length ? undefined : 'brew install php',
    required: false
  })

  // Asked of the runtime registry, not of `docker` directly: the user may have
  // chosen Podman, or OrbStack, and naming a product they did not pick is how
  // "install Colima" ended up in front of someone running Docker Desktop.
  const runtimes = await harbor.containers.describeAll().catch(() => [])
  const active = runtimes.find((r) => r.selected)
  out.push({
    id: 'container-runtime',
    label: 'Container runtime',
    status: active?.running ? 'ok' : 'warn',
    detail: active
      ? `${active.displayName} — ${active.detail}`
      : 'none installed — services that need containers are unavailable',
    remedy: active?.running
      ? undefined
      : active
        ? active.startable
          ? `Start ${active.displayName} from Settings`
          : `Open ${active.displayName}`
        : 'Choose and install one in Settings',
    required: false
  })

  // ── public exposure ───────────────────────────────────────────────────────
  // Only ever present when something is exposed, so it is loud when it matters
  // and silent otherwise: the dangerous failure is forgetting a tunnel is up.
  const tunnels = harbor.tunnels.activeList()
  if (tunnels.length) {
    out.push({
      id: 'tunnels',
      label: 'Public tunnels',
      status: 'warn',
      detail: tunnels
        .map((t) => `${t.domain} → ${t.url ?? `${t.provider} (connecting)`}`)
        .join('; '),
      remedy: `Reachable from the internet. Stop with: harbor tunnel stop <name>`,
      required: false
    })
  }

  const cli = cliStatus()
  out.push({
    id: 'cli',
    label: 'harbor command',
    status: cli.onPath ? 'ok' : cli.installed ? 'warn' : 'fail',
    detail: !cli.installed
      ? 'not installed'
      : cli.linked
        ? `linked at ${cli.linkPath}`
        : `installed at ${cli.path}, not on PATH`,
    remedy: cli.onPath ? undefined : 'Add it to PATH from Settings',
    required: false
  })

  return out
}

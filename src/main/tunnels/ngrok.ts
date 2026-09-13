import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { TunnelCapability } from '../../shared/tunnel.js'
import type { NativeBackend } from '../backends/native-backend.js'
import { resolveBinary } from '../core/resolve-binary.js'
import type { TunnelDriver, TunnelOrigin, TunnelSpawnPlan } from './types.js'

/** Where ngrok v3 (and the legacy v2) keep the config that holds the authtoken. */
const CONFIG_PATHS = [
  join(homedir(), 'Library', 'Application Support', 'ngrok', 'ngrok.yml'),
  join(homedir(), '.config', 'ngrok', 'ngrok.yml'),
  join(homedir(), '.ngrok2', 'ngrok.yml')
]

/**
 * ngrok's public URL in its JSON log line, and in the legacy logfmt line, so
 * either `--log-format` yields it. The loopback origin is filtered out by the
 * caller so only the public URL is taken.
 */
const JSON_URL = /"url":"(https:\/\/[^"]+)"/
const LOGFMT_URL = /\burl=(https:\/\/\S+)/

/**
 * ngrok. Built to the same contract as cloudflared, for the reason the captain
 * gave: a paid ngrok account issues reserved project URLs, so the seam is where
 * "does my URL survive a restart" is actually decided.
 *
 * On this machine ngrok is installed but has no config and no authtoken, and
 * modern ngrok needs one even for an ephemeral tunnel — so it cannot be
 * exercised end to end here. That is reported plainly rather than papered over:
 * `probe()` says exactly what is missing and where to get it, before anything
 * tries to use it.
 */
export class NgrokDriver implements TunnelDriver {
  readonly id = 'ngrok'
  readonly displayName = 'ngrok'

  constructor(private readonly native: NativeBackend) {}

  binary(): string | null {
    return this.native.which('ngrok') ?? resolveBinary('ngrok')
  }

  async install(): Promise<void> {
    await this.native.brewInstall('ngrok')
  }

  private hasAuthtoken(): boolean {
    for (const path of CONFIG_PATHS) {
      if (!existsSync(path)) continue
      try {
        if (/\bauthtoken\s*:/.test(readFileSync(path, 'utf8'))) return true
      } catch {
        /* unreadable config is treated as absent */
      }
    }
    return false
  }

  async probe(): Promise<TunnelCapability> {
    if (!this.binary()) {
      return {
        provider: this.id,
        displayName: this.displayName,
        installed: false,
        authenticated: false,
        hostname: 'unknown',
        detail: 'not installed — Harbor will fetch it with Homebrew'
      }
    }

    if (!this.hasAuthtoken()) {
      return {
        provider: this.id,
        displayName: this.displayName,
        installed: true,
        authenticated: false,
        // Said here, at the point of asking — not raised as a failure when a
        // tunnel is started.
        authHint:
          'ngrok has no authtoken. Get one at https://dashboard.ngrok.com/get-started/your-authtoken ' +
          'and run: ngrok config add-authtoken <token>',
        hostname: 'unknown',
        detail: 'installed but not signed in'
      }
    }

    return {
      provider: this.id,
      displayName: this.displayName,
      installed: true,
      authenticated: true,
      // Whether the account carries a reserved domain (paid) cannot be read from
      // the machine — only the ngrok API knows the tier. Reported as unknown
      // rather than guessed; a reserved domain, when present, is selected via
      // the tunnel provider's own `--domain`.
      hostname: 'unknown',
      detail:
        'signed in; a paid reserved domain keeps the URL across restarts, a free tunnel changes it'
    }
  }

  /**
   * Preserve the project's hostname to nginx via `--host-header`, and forward to
   * the origin scheme the project is served on. JSON logging to stdout is how
   * the public URL is captured.
   *
   * Honest limitation: for a secured project this forwards to the HTTPS origin,
   * and ngrok sends the loopback address as SNI rather than the project domain,
   * so nginx's HTTPS vhost selection depends on the Host header alone. Because
   * ngrok cannot be authenticated on this machine, this path is not exercised —
   * see `verify:tunnel`, which proves the argv and the hostname-preservation
   * semantics but reports the end-to-end ngrok run as an untested gap.
   */
  plan(origin: TunnelOrigin): TunnelSpawnPlan {
    const command = this.binary()
    if (!command) throw new Error('ngrok is not installed')

    const scheme = origin.secure ? 'https' : 'http'
    return {
      command,
      args: [
        'http',
        `${scheme}://${origin.host}:${origin.port}`,
        `--host-header=${origin.domain}`,
        '--log=stdout',
        '--log-format=json'
      ]
    }
  }

  parseUrl(line: string): string | null {
    const url = JSON_URL.exec(line)?.[1] ?? LOGFMT_URL.exec(line)?.[1] ?? null
    if (!url) return null
    // The origin (http://127.0.0.1:443) also appears as an `addr`/`url`; take
    // only the public hostname.
    return /127\.0\.0\.1|localhost/.test(url) ? null : url
  }
}

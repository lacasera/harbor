import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { TunnelCapability } from '../../shared/tunnel.js'
import type { NativeBackend } from '../backends/native-backend.js'
import { resolveBinary } from '../core/resolve-binary.js'
import type { TunnelDriver, TunnelOrigin, TunnelSpawnPlan } from './types.js'

/** Cloudflare's login credential; its presence is what unlocks named tunnels. */
const CLOUDFLARED_CERT = join(homedir(), '.cloudflared', 'cert.pem')

/** cloudflared prints its quick-tunnel URL once, on stderr, at startup. */
const QUICK_URL = /(https:\/\/[a-z0-9-]+\.trycloudflare\.com)/i

/**
 * cloudflared. The provider that must work end to end.
 *
 * With no `~/.cloudflared` this offers only *quick tunnels*: a random
 * `*.trycloudflare.com` hostname, a fresh URL every start. That is ephemeral by
 * nature, so every restart issues a different URL — which the supervisor's
 * notification has to carry. A stable Cloudflare hostname needs a named tunnel
 * and DNS records that Harbor does not automate in v1; the driver reports which
 * of the two it can do rather than pretending.
 */
export class CloudflaredDriver implements TunnelDriver {
  readonly id = 'cloudflared'
  readonly displayName = 'Cloudflare Tunnel'

  constructor(private readonly native: NativeBackend) {}

  binary(): string | null {
    return this.native.which('cloudflared') ?? resolveBinary('cloudflared')
  }

  async install(): Promise<void> {
    await this.native.brewInstall('cloudflared')
  }

  async probe(): Promise<TunnelCapability> {
    const installed = Boolean(this.binary())
    if (!installed) {
      return {
        provider: this.id,
        displayName: this.displayName,
        installed: false,
        authenticated: false,
        hostname: 'unknown',
        detail: 'not installed — Harbor will fetch it with Homebrew'
      }
    }

    // Quick tunnels need no login at all, so cloudflared is always usable. A
    // login only decides whether a *reserved* hostname is possible on top.
    const loggedIn = existsSync(CLOUDFLARED_CERT)
    return {
      provider: this.id,
      displayName: this.displayName,
      authenticated: true,
      installed: true,
      // Even logged in, a reserved Cloudflare hostname needs a named tunnel and
      // DNS route that Harbor does not create yet — so quick tunnels remain the
      // honest capability, and the URL changes on every start.
      hostname: 'ephemeral',
      detail: loggedIn
        ? 'signed in; using quick tunnels — URL changes on every start'
        : 'quick tunnels — URL changes on every start (no Cloudflare account needed)'
    }
  }

  /**
   * Forward to Harbor's nginx while preserving the project's hostname.
   *
   *   --http-host-header <domain>   the Host header nginx matches `server_name`
   *                                 against, so it picks this project's vhost
   *                                 rather than the catch-all.
   *   --origin-server-name <domain> the TLS SNI cloudflared sends, so nginx
   *                                 selects the right HTTPS server block and
   *                                 presents this project's certificate.
   *   --no-tls-verify               tolerate Harbor's local CA without depending
   *                                 on it being trusted in the system store.
   */
  plan(origin: TunnelOrigin): TunnelSpawnPlan {
    const command = this.binary()
    if (!command) throw new Error('cloudflared is not installed')

    const scheme = origin.secure ? 'https' : 'http'
    const args = [
      'tunnel',
      '--no-autoupdate',
      '--url',
      `${scheme}://${origin.host}:${origin.port}`,
      '--http-host-header',
      origin.domain
    ]
    if (origin.secure) {
      args.push('--origin-server-name', origin.domain, '--no-tls-verify')
    }
    return { command, args }
  }

  parseUrl(line: string): string | null {
    return QUICK_URL.exec(line)?.[1] ?? null
  }
}

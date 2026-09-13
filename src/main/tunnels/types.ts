import type { TunnelCapability, TunnelProviderId } from '../../shared/tunnel.js'

/**
 * The local target a tunnel forwards to.
 *
 * `domain` is the whole point: every Harbor project shares one nginx and is
 * distinguished only by `server_name`, so a tunnel that forwards to
 * `https://127.0.0.1:443` without declaring which host it wants falls through
 * to the catch-all vhost and silently serves the wrong project. The driver's
 * job is to preserve `domain` to the origin — as the HTTP Host header and, for
 * a secured origin, as the TLS SNI — and to tolerate Harbor's own certificate
 * on that hop.
 */
export interface TunnelOrigin {
  /** The project's public-facing hostname, preserved to nginx. */
  domain: string
  /** Where nginx listens; always loopback. */
  host: string
  /** The nginx listen port for this project (its HTTPS port when secured). */
  port: number
  /** Forward to an `https://` origin, tolerating Harbor's local certificate. */
  secure: boolean
}

/** A ready-to-spawn provider command. Pure output of `plan()`, so it is testable. */
export interface TunnelSpawnPlan {
  command: string
  args: string[]
  env?: Record<string, string>
}

/**
 * One tunnel provider. The seam the captain asked for: a paid ngrok account can
 * issue custom project URLs, so the provider choice is the answer to "does my
 * URL survive a restart" — which makes this contract load-bearing rather than
 * tidy. Each driver answers for its own installation, authentication and tier.
 */
export interface TunnelDriver {
  id: TunnelProviderId
  displayName: string
  /** Absolute path to the provider binary, or null when it is not installed. */
  binary(): string | null
  /** Fetch the provider itself, per Harbor's install pattern. */
  install(): Promise<void>
  /** Installed? authenticated? reserved or only ephemeral? — all probed. */
  probe(): Promise<TunnelCapability>
  /**
   * Build the argv that exposes `origin`, preserving its hostname and tolerating
   * Harbor's certificate. The whole sharp-edge fix lives here, and it is pure so
   * a test can assert on it without spawning anything.
   */
  plan(origin: TunnelOrigin): TunnelSpawnPlan
  /** Pull the public URL out of one line of provider output, or null. */
  parseUrl(line: string): string | null
}

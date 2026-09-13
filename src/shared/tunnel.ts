/**
 * Public tunnels: exposing one parked project to the internet through a
 * provider (cloudflared, ngrok) that terminates a publicly-trusted certificate
 * and forwards to Harbor's nginx.
 *
 * Everything here is wire-safe — the shapes the CLI, the renderer and the main
 * process agree on. The driver contract itself lives in the main process
 * (`src/main/tunnels/types.ts`); it is not serialisable and never crosses IPC.
 */

export type TunnelProviderId = 'cloudflared' | 'ngrok' | (string & {})

/**
 * Whether a restart keeps the public URL or issues a new one — the single fact
 * that decides how invisible auto-restart can be, so it is reported rather than
 * assumed. `unknown` is honest when a provider is not authenticated yet and its
 * account tier cannot be probed.
 */
export type TunnelHostnameKind = 'reserved' | 'ephemeral' | 'unknown'

/**
 * What a provider can actually do on THIS machine, probed rather than assumed.
 *
 * The tier is never hardcoded: there is no `~/.cloudflared` and ngrok has no
 * authtoken here, so the only workable answer is to ask the provider and report
 * what comes back — which also survives the captain upgrading his account later.
 */
export interface TunnelCapability {
  provider: TunnelProviderId
  displayName: string
  /** The provider binary is on the machine. When false, Harbor installs it. */
  installed: boolean
  /** Usable right now. When false, `authHint` says exactly what is missing. */
  authenticated: boolean
  /**
   * Precisely what to supply, and how, when not authenticated — an authtoken, a
   * Cloudflare login. Surfaced at the point of asking, never as a failure at the
   * moment of use.
   */
  authHint?: string
  /** Whether an issued URL survives a restart. */
  hostname: TunnelHostnameKind
  /** Human note about installation, auth or the hostname situation. */
  detail?: string
}

export type TunnelState = 'starting' | 'live' | 'restarting' | 'error'

/** A tunnel that is deliberately up right now. */
export interface ActiveTunnel {
  projectId: string
  projectName: string
  /** The project hostname preserved to nginx — the sharp edge. */
  domain: string
  provider: TunnelProviderId
  /** The public URL, once the provider has issued one. */
  url: string | null
  hostname: TunnelHostnameKind
  startedAt: number
  /** Unexpected restarts since this tunnel was asked to come up. */
  restarts: number
  state: TunnelState
  /** Populated when `state` is `error`. */
  error?: string
}

/** Everything `harbor tunnel status` and the app need to render tunnels. */
export interface TunnelStatus {
  /** The config-selected default provider a bare `harbor tunnel` uses. */
  defaultProvider: TunnelProviderId
  /** Every registered provider and what it can do here. */
  providers: TunnelCapability[]
  /** Projects exposed right now. */
  active: ActiveTunnel[]
}

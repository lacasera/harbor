import type { NativeBackend } from '../backends/native-backend.js'
import { CloudflaredDriver } from './cloudflared.js'
import { NgrokDriver } from './ngrok.js'
import { TunnelProviders } from './registry.js'

export { TunnelProviders } from './registry.js'
export { TunnelManager } from './manager.js'
export type { TunnelProjectInfo, TunnelProjectResolver } from './manager.js'

/**
 * The tunnel providers. cloudflared works end to end against quick tunnels;
 * ngrok is built to the same contract for its reserved-domain URLs. Adding one
 * is a driver plus a line here.
 */
export function registerTunnelDrivers(
  providers: TunnelProviders,
  deps: { native: NativeBackend }
): void {
  providers.register(new CloudflaredDriver(deps.native))
  providers.register(new NgrokDriver(deps.native))
}

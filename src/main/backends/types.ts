import type { ProcessHandle } from '../../shared/process.js'
import type { ServiceInstanceRef } from '../../shared/service.js'

export interface BackendStartOptions {
  ref: ServiceInstanceRef
  displayName: string
}

/**
 * Generic in its start options: a native service is started with a command,
 * a Docker service with a compose fragment. Everything else — identity,
 * availability probing, stop-by-instance — is uniform.
 *
 * Every method takes a full instance ref rather than a service id, because
 * two projects can each run their own MySQL: `mysql` alone no longer names
 * anything a backend can act on.
 */
export interface Backend<StartOptions extends BackendStartOptions = BackendStartOptions> {
  id: 'native' | 'docker'
  /** Whether the backend itself is usable (brew present, Colima running, …). */
  available(): Promise<{ ok: boolean; reason?: string }>
  start(options: StartOptions): Promise<ProcessHandle>
  stop(ref: ServiceInstanceRef): Promise<void>
}

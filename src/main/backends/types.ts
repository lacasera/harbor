import type { ProcessHandle } from '../../shared/process.js'

export interface BackendStartOptions {
  serviceId: string
  displayName: string
}

/**
 * Generic in its start options: a native service is started with a command,
 * a Docker service with a compose fragment. Everything else — identity,
 * availability probing, stop-by-service-id — is uniform.
 */
export interface Backend<StartOptions extends BackendStartOptions = BackendStartOptions> {
  id: 'native' | 'docker'
  /** Whether the backend itself is usable (brew present, Colima running, …). */
  available(): Promise<{ ok: boolean; reason?: string }>
  start(options: StartOptions): Promise<ProcessHandle>
  stop(serviceId: string): Promise<void>
}

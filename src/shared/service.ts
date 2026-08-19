import type { JSONSchema } from './json-schema.js'
import type { LogSource } from './logs.js'
import type { ProcessHandle } from './process.js'

export type BackendKind = 'native' | 'docker'

export type ServiceHealth = 'stopped' | 'starting' | 'running' | 'unhealthy' | 'error'

export interface ServiceStatus {
  health: ServiceHealth
  /** Ports the service is actually bound to right now. */
  ports: number[]
  /** Free-form detail shown under the card, e.g. "console on :9001". */
  detail?: string
  /** Populated when health is "error"/"unhealthy". */
  error?: string
}

/** Persisted, user-editable configuration for one service instance. */
export interface ServiceConfig {
  serviceId: string
  version: string
  /** Values validated against the driver's `configSchema`. */
  values: Record<string, unknown>
  /** Start this service when Harbor launches. */
  autoStart: boolean
}

/**
 * The contract every backing service implements. Everything the UI shows for a
 * service — card, toggle, config form, log wiring, .env snippet — is generated
 * from this metadata. If a service needs bespoke UI, push the variation in here
 * instead.
 */
export interface ServiceDriver {
  id: string
  displayName: string
  /** Short blurb for the service card. */
  description?: string
  backend: BackendKind
  defaultPorts: number[]
  /** Versions offered in the install dropdown; first entry is the default. */
  availableVersions(): Promise<string[]>
  installedVersions(): Promise<string[]>
  install(version: string): Promise<void>
  start(config: ServiceConfig): Promise<ProcessHandle>
  stop(): Promise<void>
  healthCheck(): Promise<ServiceStatus>
  configSchema: JSONSchema
  logSources: LogSource[]
  /**
   * `.env` keys this service exports. Values are templates resolved against the
   * live config — see `resolveEnvHints`. Never hardcode a port here that the
   * user can change; reference the config key instead: "${port}".
   */
  envHints: Record<string, string>
}

/** Wire-safe description of a service, sent to the renderer. */
export interface ServiceDescriptor {
  id: string
  displayName: string
  description?: string
  backend: BackendKind
  defaultPorts: number[]
  configSchema: JSONSchema
  envKeys: string[]
  installed: boolean
  installedVersions: string[]
  config: ServiceConfig
  status: ServiceStatus
}

export interface EnvBlock {
  serviceId: string
  displayName: string
  vars: Array<{ key: string; value: string }>
}

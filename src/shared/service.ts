import type { JSONSchema } from './json-schema.js'
import type { LogSource } from './logs.js'
import type { ProcessHandle } from './process.js'

export type BackendKind = 'native' | 'docker'

/**
 * What a service *is*, which is what its icon should show.
 *
 * Deliberately a category rather than a brand: shipping redrawn trademarks is
 * a licensing problem, and a category glyph stays correct when a service is
 * renamed or forked. A driver declares its own, so adding a service never
 * means editing an icon map in the renderer.
 */
export type ServiceIconKind =
  | 'storage'
  | 'search'
  | 'queue'
  | 'stream'
  | 'cloud'
  | 'database'
  | 'cache'
  | 'mail'
  | 'generic'

/**
 * A web UI a service ships with — MinIO's console, RabbitMQ's management page,
 * Mailpit's inbox. Declared by the driver against the instance's live port, so
 * the UI never has to know which services have one or where it lives.
 */
export interface ServiceConsole {
  /** Button label, e.g. "Open console". */
  label: string
  url: string
}

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

/**
 * Who owns a service instance: a project id, or `machine` for the two native
 * services that are not per-project yet.
 *
 * A plain string rather than a union so there is exactly one code path. Every
 * name Harbor derives — compose project, data directory, log file, process
 * owner, port allocation key — is built from `(owner, serviceId)`, which is
 * what allows two projects to run the same service at once.
 */
export type ServiceOwnerId = string

/** Reserved owner for services that are still machine-wide. */
export const MACHINE_OWNER = 'machine'

export interface ServiceInstanceRef {
  owner: ServiceOwnerId
  serviceId: string
}

/** `${owner}:${serviceId}` — the one derived name everything else keys off. */
export type ServiceInstanceKey = string

export function instanceKey(ref: ServiceInstanceRef): ServiceInstanceKey {
  return `${ref.owner}:${ref.serviceId}`
}

export function parseInstanceKey(key: ServiceInstanceKey): ServiceInstanceRef {
  const at = key.indexOf(':')
  return { owner: key.slice(0, at), serviceId: key.slice(at + 1) }
}

/** Persisted, user-editable configuration for ONE instance of a service. */
export interface ServiceInstance {
  owner: ServiceOwnerId
  serviceId: string
  version: string
  /**
   * Values validated against the driver's effective schema. Allocated host
   * ports are written back in here rather than kept alongside, so the fragment,
   * the generated form, the conflict check and the `.env` block all read one
   * source of truth.
   */
  values: Record<string, unknown>
  /** Start this instance when its owner starts. */
  autoStart: boolean
  createdAt: number
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
  /** Which glyph represents it. Defaults to a monogram when absent. */
  icon?: ServiceIconKind
  /** Brand-ish accent for the tile, so services stay distinguishable. */
  tint?: string
  /** Versions offered in the install dropdown; first entry is the default. */
  availableVersions(): Promise<string[]>
  installedVersions(): Promise<string[]>
  install(version: string): Promise<void>
  /**
   * Ports this service will actually bind, given its live config. Defaults to
   * `defaultPorts`; drivers whose schema renames or adds ports override it so
   * Harbor can check for conflicts before starting.
   */
  configuredPorts?(instance: ServiceInstance): number[]
  /**
   * Every lifecycle method takes the instance it acts on. Drivers hold no
   * per-instance state of their own — the single `running` slot they used to
   * keep was both what made them single-instance and the source of a service
   * reporting default ports after a restart.
   */
  start(instance: ServiceInstance): Promise<ProcessHandle>
  stop(instance: ServiceInstance): Promise<void>
  healthCheck(instance: ServiceInstance): Promise<ServiceStatus>
  /**
   * The service's own web UI, resolved against this instance's live port.
   * Absent for services that have none — most databases — so the button simply
   * does not appear rather than opening something that isn't there.
   */
  console?(instance: ServiceInstance): ServiceConsole | null
  /**
   * Reconcile the running service with its configuration, after it is healthy.
   *
   * Most container images apply their `MYSQL_DATABASE`-style settings only when
   * initialising an empty data directory. Once a volume exists those values are
   * inert — so changing the database name in the form did nothing at all, and
   * the only symptom was the application failing to connect much later. Anything
   * a driver cannot express as start-up configuration belongs here, and it must
   * be idempotent: it runs on every start.
   */
  bootstrap?(instance: ServiceInstance): Promise<void>
  configSchema: JSONSchema
  /** Per-instance: a log file path has to include which instance wrote it. */
  logSources(ref: ServiceInstanceRef): LogSource[]
  /**
   * `.env` keys this service exports. Values are templates resolved against the
   * live config — see `resolveEnvHints`. Never hardcode a port here that the
   * user can change; reference the config key instead: "${port}".
   */
  envHints: Record<string, string>
}

/** Wire-safe description of one running (or stopped) instance. */
export interface ServiceInstanceDescriptor extends ServiceInstance {
  key: ServiceInstanceKey
  displayName: string
  description?: string
  backend: BackendKind
  icon?: ServiceIconKind
  tint?: string
  /** The spec's schema plus the shared per-instance extras. */
  configSchema: JSONSchema
  envKeys: string[]
  installed: boolean
  installedVersions: string[]
  status: ServiceStatus
  /** This instance's web UI, or null when the service ships none. */
  console: ServiceConsole | null
  /** Compose project this instance lives in, or null for native services. */
  composeProject: string | null
}

/**
 * Wire-safe description of a service in the catalogue. Carries no config or
 * status of its own any more — those belong to instances.
 */
export interface ServiceDescriptor {
  id: string
  displayName: string
  description?: string
  backend: BackendKind
  defaultPorts: number[]
  icon?: ServiceIconKind
  tint?: string
  configSchema: JSONSchema
  envKeys: string[]
  installed: boolean
  installedVersions: string[]
  /** Every instance of this service, across all owners. */
  instances: ServiceInstanceDescriptor[]
}

/** One schema violation, addressed to the field that caused it. */
export interface FieldError {
  /** Property name, or '' for an error about the object as a whole. */
  field: string
  message: string
}

/**
 * Config updates can fail validation, which is an expected outcome rather than
 * an exception — the form needs to render the errors next to their fields.
 */
export type ConfigUpdateResult =
  | { ok: true; instance: ServiceInstanceDescriptor }
  | { ok: false; errors: FieldError[] }

export interface EnvBlock {
  serviceId: string
  /** Which instance produced it — two projects export different ports. */
  owner: ServiceOwnerId
  key: ServiceInstanceKey
  displayName: string
  vars: Array<{ key: string; value: string }>
}

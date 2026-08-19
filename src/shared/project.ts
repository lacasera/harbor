import type { LogSource } from './logs.js'
import type { ProcessState } from './process.js'
import type { ResolvedVersion, RuntimeId, RuntimeRef } from './runtime.js'

export type ServeModel = 'fpm' | 'reverse-proxy' | 'static'

export type ProjectTypeId = 'php' | 'node-server' | 'static' | 'go' | (string & {})

/** How a directory came under Harbor's management. */
export type ProjectOrigin = 'parked' | 'linked'

export interface NginxRewriteRule {
  /** Location block matcher, e.g. "/" or "~ \.php$". */
  location: string
  /** Raw directive lines placed inside the location block. */
  directives: string[]
}

export interface ProjectType {
  id: ProjectTypeId
  displayName: string
  /** Higher runs first. Specific detectors must outrank generic ones. */
  priority: number
  detect(dir: string): Promise<boolean>
  serveModel: ServeModel
  resolveRuntime(dir: string): Promise<RuntimeRef | null>
  /** null for FPM-served PHP — nginx talks to the pool, nothing to spawn. */
  startCommand(dir: string): Promise<string | null>
  defaultPort?: number
  /**
   * Where an application of this type writes its own logs, beyond whatever it
   * prints to stdout. Only the type knows: a Node server usually logs to
   * stdout, a PHP app to a file its framework chooses, a Go service to either.
   * Declared here so the aggregator never grows a branch per ecosystem.
   */
  logSources?(dir: string): LogSource[]
  /**
   * Auxiliary processes an application of this type needs. Detected from the
   * project — a queue worker is pointless if the app has no queue — so the UI
   * only ever offers things that make sense for what is actually there.
   */
  processes?(dir: string): Promise<ProjectProcessSpec[]>
}

/**
 * Parameterizes the `fpm` serve model. This nests UNDER the `php` ProjectType;
 * it is not a peer of it. Mirrors Laravel Valet's driver contract so community
 * drivers can be used as reference.
 */
export interface PhpFrameworkDriver {
  id: string
  displayName: string
  /** Higher runs first: laravel/symfony/wordpress before plain. */
  priority: number
  detect(dir: string): Promise<boolean>
  /** Relative docroot: "public" | "web" | "" (project root). */
  docroot(dir: string): string
  frontController(dir: string): string
  rewrites(dir: string): NginxRewriteRule[]
  /** Optional per-site PHP version pin (Valet parity). */
  isolatedPhpVersion?(dir: string): Promise<string | null>
  /**
   * Where this framework writes its application log. Declared per driver for
   * the same reason serving is: only the framework knows, and the aggregator
   * should not grow a branch per framework.
   */
  logSources?(dir: string): LogSource[]
  /** Framework-specific companions: queue workers, schedulers, asset builds. */
  processes?(dir: string): Promise<ProjectProcessSpec[]>
}

export interface Project {
  id: string
  /** Directory basename by default; drives the `<name>.test` domain. */
  name: string
  path: string
  origin: ProjectOrigin
  /** Detected type, unless the user overrode it. */
  typeId: ProjectTypeId
  typeOverridden: boolean
  serveModel: ServeModel
  /** For serveModel "fpm": which framework driver rendered the vhost. */
  frameworkId: string | null
  domain: string
  secure: boolean
  /** Stable allocated port for reverse-proxy projects. */
  port: number | null
  /** User-overridable start command; null means "use the type's default". */
  startCommandOverride: string | null
  /** User-pinned runtime version; null means "resolve it". */
  runtimeOverride: RuntimeRef | null
  /** Per-process user choices, keyed by spec id. */
  processOverrides: Record<string, ProjectProcessOverride>
  /**
   * Services this project uses. Drives the aggregated .env block, so it is an
   * explicit choice rather than "whatever happens to be running".
   */
  serviceIds: string[]
  createdAt: number
}

export type ProcessRestart = 'never' | 'on-failure' | 'always'

/**
 * An auxiliary process a project needs alongside being served.
 *
 * A site is rarely one process: a Laravel app wants a queue worker, a
 * scheduler and Vite; a Symfony app wants messenger. Drivers declare what an
 * application of their kind needs, detected from the project rather than
 * assumed, and the user decides which actually run.
 */
export interface ProjectProcessSpec {
  /** Stable per project, e.g. "queue" — user settings key off it. */
  id: string
  label: string
  description?: string
  command: string
  /** Which runtime provides the binary; resolved per project. */
  runtime?: RuntimeId
  /** Harbor's recommendation, not a decision. */
  autoStart: boolean
  restart: ProcessRestart
  /** Set when the process binds a port that must be allocated and injected. */
  portEnvVar?: string
}

/** A spec plus the user's choices and its live state. */
export interface ProjectProcessDescriptor extends ProjectProcessSpec {
  enabled: boolean
  /** True when the command differs from what the driver detected. */
  overridden: boolean
  running: boolean
  processId: string | null
  pid: number | null
  state: ProcessState
}

/** What the user changed about a detected process. */
export interface ProjectProcessOverride {
  enabled?: boolean
  command?: string
}

export interface ProjectEnvVar {
  key: string
  value: string
  /** Looks like a credential; the UI masks it until asked. */
  secret: boolean
}

export interface ProjectEnvFile {
  path: string
  exists: boolean
  vars: ProjectEnvVar[]
}

export interface ProjectDescriptor extends Project {
  resolvedRuntime: ResolvedVersion | null
  resolvedStartCommand: string | null
  /** ProcessManager id of the dev server, when running. */
  processId: string | null
  /** The project's own dev-server process. Always false for fpm and static. */
  running: boolean
  /**
   * Whether a request to this site would actually be answered right now.
   * An fpm site has no process of its own — nginx and a PHP-FPM pool serve it —
   * so process state is the wrong question to ask of it.
   */
  served: boolean
  /** What is doing the serving, e.g. "php-fpm 8.5" or "node · pid 41902". */
  servedBy: string | null
  /** Why it isn't served, when it isn't. */
  servedProblem: string | null
  /** Queue workers, schedulers, asset builds — detected and user-controlled. */
  processes: ProjectProcessDescriptor[]
  url: string
}

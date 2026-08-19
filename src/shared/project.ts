import type { ResolvedVersion, RuntimeRef } from './runtime.js'

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
  /**
   * Services this project uses. Drives the aggregated .env block, so it is an
   * explicit choice rather than "whatever happens to be running".
   */
  serviceIds: string[]
  createdAt: number
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
  url: string
}

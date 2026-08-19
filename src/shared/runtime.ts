export type RuntimeId = 'node' | 'bun' | 'deno' | 'php' | (string & {})

export interface RuntimeRef {
  runtime: RuntimeId
  version: string
}

export type VersionSourceKind =
  | 'app-override'
  | 'version-file'
  | 'manifest'
  | 'runtime-default'

export interface ResolvedVersion {
  runtime: RuntimeId
  version: string
  source: VersionSourceKind
  /** e.g. ".nvmrc", "package.json#engines.node", "ConfigStore" */
  detail: string
  /** Absolute path to the binary, or null when the version isn't installed. */
  binary: string | null
  installed: boolean
}

/**
 * A configuration file a runtime exposes for editing — php.ini being the case
 * everyone reaches for first.
 *
 * Declared by the driver, because only it knows where its settings live and
 * what changing them affects. The renderer edits by `id`, never by path: it is
 * a sandboxed presentation layer, and letting it name a file to write would
 * hand it the filesystem through the back door.
 */
export interface RuntimeConfigFileSpec {
  /** Stable per runtime+version, e.g. "overrides" | "php.ini". */
  id: string
  label: string
  path: string
  /**
   * Who the file belongs to. `harbor` files are created and owned by Harbor and
   * safe to edit freely; `system` files belong to the package manager, are
   * shared with the user's own tooling, and can be replaced by an upgrade.
   */
  owner: 'harbor' | 'system'
  /** What editing it changes, in the user's terms. Shown above the editor. */
  scope: string
  description?: string
}

/** A spec plus what is actually on disk. */
export interface RuntimeConfigFile extends RuntimeConfigFileSpec {
  exists: boolean
  content: string
}

/**
 * Whether a newer version of something installed is available.
 *
 * `latest` is null when the check could not be made — no network, a rate
 * limited API, Homebrew not installed. That is deliberately distinct from
 * "up to date": telling someone they are current when you failed to look is
 * the one answer worse than saying nothing.
 */
export interface UpdateInfo {
  current: string
  latest: string | null
  available: boolean
  /**
   * The update crosses a major version. Harbor still offers it, but a one-click
   * button should not quietly move a project onto a release that can break it.
   */
  major: boolean
  /** What applying it will do, in the user's terms. */
  action: string
  /** Why the check could not be made, when `latest` is null. */
  error?: string
}

export interface RuntimeDriver {
  id: RuntimeId
  displayName: string
  /** Filenames checked by the VersionResolver, in priority order. */
  versionFiles: string[]
  install(version: string): Promise<void>
  uninstall(version: string): Promise<void>
  installedVersions(): Promise<string[]>
  availableVersions(): Promise<string[]>
  /** Absolute path to the binary for a version. Does not check existence. */
  resolveBinary(version: string): string
  pin(projectPath: string, version: string): Promise<void>
  activeVersion(projectPath: string): Promise<string | null>
  /**
   * Editable configuration for one installed version. Runtimes with nothing
   * worth editing simply do not implement it.
   */
  configFiles?(version: string): RuntimeConfigFileSpec[]
  /**
   * Whether a newer version of an installed one exists.
   *
   * Per driver because "newer" is not one question: Harbor installs Node
   * side-by-side under its own directory, while PHP comes from Homebrew and is
   * upgraded in place. Only the driver knows which, and what to call it.
   */
  checkUpdate?(version: string): Promise<UpdateInfo>
  /** Apply the update `checkUpdate` reported. Returns the version now current. */
  update?(version: string): Promise<string>
}

/** Wire-safe description of a runtime, sent to the renderer. */
export interface RuntimeDescriptor {
  id: RuntimeId
  displayName: string
  installedVersions: string[]
  defaultVersion: string | null
  /** Whether this runtime exposes editable configuration files. */
  configurable: boolean
}

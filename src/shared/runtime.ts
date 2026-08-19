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
}

/** Wire-safe description of a runtime, sent to the renderer. */
export interface RuntimeDescriptor {
  id: RuntimeId
  displayName: string
  installedVersions: string[]
  defaultVersion: string | null
}

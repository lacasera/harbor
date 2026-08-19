export type ProcessState = 'starting' | 'running' | 'stopping' | 'stopped' | 'crashed'

/** Who a process belongs to. Used for log tagging and lifecycle grouping. */
export type ProcessOwnerKind = 'service' | 'project' | 'system'

export interface ProcessOwner {
  kind: ProcessOwnerKind
  /** service id, project id, or a system component name */
  id: string
  /**
   * Which of the owner's processes this is: "server" for the thing nginx
   * proxies to, or a spec id like "queue". A project runs several at once, so
   * the owner id alone no longer identifies one.
   */
  role?: string
}

export interface SpawnRequest {
  owner: ProcessOwner
  /** Human label shown in the log viewer and process list. */
  label: string
  command: string
  args?: string[]
  cwd?: string
  env?: Record<string, string>
  /**
   * When set, ProcessManager allocates (or reuses) a stable port for this
   * owner and injects it as `env[portEnvVar]` before spawning.
   */
  portEnvVar?: string
  /** Preferred port when allocating for the first time. */
  preferredPort?: number
  /**
   * Stream name for the log viewer. Defaults to stdout/stderr; a project's
   * companions set it so "queue" and "vite" are distinguishable under the one
   * project source.
   */
  logStream?: string
}

/** Serializable view of a managed process. Safe to send over IPC. */
export interface ProcessHandle {
  /** ProcessManager-scoped identifier, stable for the process's lifetime. */
  id: string
  owner: ProcessOwner
  label: string
  pid: number | null
  state: ProcessState
  command: string
  args: string[]
  cwd: string | null
  /** Port allocated for this process, if any. */
  port: number | null
  startedAt: number | null
  exitedAt: number | null
  exitCode: number | null
  restarts: number
}

export interface ResourceUsage {
  processId: string
  pid: number
  /** Percent of a single core. */
  cpu: number
  /** Resident set size, bytes. */
  memory: number
  sampledAt: number
}

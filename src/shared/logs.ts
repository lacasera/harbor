export type LogLevel = 'trace' | 'debug' | 'info' | 'warn' | 'error' | 'unknown'

export interface LogSource {
  /** "file" tails a path; "stdout"/"stderr" attach to a managed process. */
  kind: 'file' | 'stdout' | 'stderr'
  /** Absolute path for `kind: "file"`. Ignored otherwise. */
  path?: string
  /** Display name, e.g. "minio.log". Defaults to the driver's displayName. */
  label?: string
}

/** One normalized line from any source in the system. */
export interface LogLine {
  id: number
  /** Emitting subsystem: service id, project id, or system component. */
  source: string
  /** Sub-source, e.g. the file name or "stderr". */
  stream: string
  level: LogLevel
  timestamp: number
  message: string
}

export interface LogQuery {
  sources?: string[]
  levels?: LogLevel[]
  /** Case-insensitive substring match. */
  search?: string
  limit?: number
  /** Only lines with `id` greater than this. */
  since?: number
}

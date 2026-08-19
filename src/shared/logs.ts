export type LogLevel = 'trace' | 'debug' | 'info' | 'warn' | 'error' | 'unknown'

export interface LogSource {
  /**
   * "file" tails one path; "dir" tails every matching file in a directory and
   * picks up ones created later; "stdout"/"stderr" attach to a managed process.
   *
   * "dir" exists because the interesting logs are rarely a fixed path: Laravel's
   * daily channel writes laravel-2026-08-19.log, and nginx only creates a site's
   * access log on the first request.
   */
  kind: 'file' | 'dir' | 'stdout' | 'stderr'
  /** Absolute path for "file", or the directory for "dir". */
  path?: string
  /** For "dir": which filenames to tail. Defaults to everything ending .log. */
  match?: string
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

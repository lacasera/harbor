import { EventEmitter } from 'node:events'
import {
  createReadStream,
  existsSync,
  readdirSync,
  statSync,
  watch,
  type FSWatcher
} from 'node:fs'
import { basename, join } from 'node:path'
import type { LogLevel, LogLine, LogQuery, LogSource } from '../../shared/logs.js'
import type { ProcessHandle } from '../../shared/process.js'
import type { ProcessManager } from './process-manager.js'

const RING_SIZE = 20_000

const LEVEL_PATTERNS: Array<[LogLevel, RegExp]> = [
  ['error', /\b(error|err|fatal|panic|exception)\b/i],
  ['warn', /\b(warn|warning|deprecated)\b/i],
  ['debug', /\b(debug)\b/i],
  ['trace', /\b(trace|verbose)\b/i],
  ['info', /\b(info|notice)\b/i]
]

/**
 * Central tail of every driver's logSources plus every managed process's
 * stdout. Built early on purpose: once a dozen services exist, retrofitting a
 * uniform log pipeline means touching all of them.
 */
export class LogAggregator extends EventEmitter {
  private readonly ring: LogLine[] = []
  private nextId = 1
  private readonly sources = new Set<string>()
  private readonly watchers = new Map<string, { watcher: FSWatcher; offset: number }>()
  private readonly dirWatchers = new Map<string, FSWatcher>()

  constructor(processes: ProcessManager) {
    super()
    processes.on(
      'log',
      ({ handle, stream, chunk }: { handle: ProcessHandle; stream: string; chunk: string }) => {
        for (const line of chunk.split('\n')) {
          if (line.trim()) this.push(handle.owner.id, stream, line)
        }
      }
    )
  }

  /** Attach a driver's declared file sources. stdout/stderr arrive for free. */
  attach(sourceId: string, logSources: LogSource[]): void {
    for (const src of logSources) {
      if (!src.path) continue
      if (src.kind === 'file') this.tailFile(sourceId, src.label ?? basename(src.path), src.path)
      else if (src.kind === 'dir') this.tailDirectory(sourceId, src)
    }
  }

  /**
   * Tail every matching file in a directory, including ones that appear later.
   * A log that does not exist yet is the normal case — Laravel writes its first
   * line when something is logged, nginx creates a site's access log on the
   * first request — and a one-shot existence check misses all of them.
   */
  private tailDirectory(sourceId: string, src: LogSource): void {
    const dir = src.path as string
    const pattern = src.match ? new RegExp(src.match) : /\.log$/
    const key = `${sourceId}::dir::${dir}`
    if (this.dirWatchers.has(key) || !existsSync(dir)) return

    const scan = (): void => {
      let entries: string[] = []
      try {
        entries = readdirSync(dir)
      } catch {
        return
      }
      for (const entry of entries) {
        if (!pattern.test(entry)) continue
        this.tailFile(sourceId, src.label ? `${src.label}/${entry}` : entry, join(dir, entry))
      }
    }

    scan()
    try {
      this.dirWatchers.set(key, watch(dir, () => scan()))
    } catch {
      /* unwatchable directory is not worth failing over */
    }
  }

  detach(sourceId: string): void {
    for (const [key, entry] of this.watchers) {
      if (key.startsWith(`${sourceId}::`)) {
        entry.watcher.close()
        this.watchers.delete(key)
      }
    }
    for (const [key, watcher] of this.dirWatchers) {
      if (key.startsWith(`${sourceId}::`)) {
        watcher.close()
        this.dirWatchers.delete(key)
      }
    }
  }

  private tailFile(sourceId: string, label: string, path: string, fromStart = false): void {
    const key = `${sourceId}::${path}`
    if (this.watchers.has(key) || !existsSync(path)) return

    // Existing logs start from the end — nobody wants a 40 MB laravel.log
    // replayed into the viewer — but the last few lines are useful context.
    const size = statSync(path).size
    const offset = fromStart ? 0 : size
    if (!fromStart && size > 0) this.readTail(sourceId, label, path, size)
    const watcher = watch(path, () => {
      const entry = this.watchers.get(key)
      if (!entry) return
      let size: number
      try {
        size = statSync(path).size
      } catch {
        return
      }
      // Truncation (logrotate) resets the read head rather than replaying.
      if (size < entry.offset) entry.offset = 0
      if (size === entry.offset) return

      const stream = createReadStream(path, { start: entry.offset, end: size - 1, encoding: 'utf8' })
      entry.offset = size
      let buf = ''
      stream.on('data', (c) => (buf += c))
      stream.on('end', () => {
        for (const line of buf.split('\n')) {
          if (line.trim()) this.push(sourceId, label, line)
        }
      })
    })
    this.watchers.set(key, { watcher, offset })
  }

  /** Emit the final few KB of an existing file so the viewer opens with context. */
  private readTail(sourceId: string, label: string, path: string, size: number): void {
    const window = 16 * 1024
    const start = Math.max(0, size - window)
    const stream = createReadStream(path, { start, end: size - 1, encoding: 'utf8' })
    let buf = ''
    stream.on('data', (c) => (buf += c))
    stream.on('error', () => undefined)
    stream.on('end', () => {
      const lines = buf.split('\n')
      // Drop a partial first line when we started mid-file.
      if (start > 0) lines.shift()
      for (const line of lines.slice(-40)) {
        if (line.trim()) this.push(sourceId, label, line)
      }
    })
  }

  push(source: string, stream: string, message: string): void {
    this.sources.add(source)
    const line: LogLine = {
      id: this.nextId++,
      source,
      stream,
      level: detectLevel(message),
      timestamp: Date.now(),
      message: message.replace(/\s+$/, '')
    }
    this.ring.push(line)
    if (this.ring.length > RING_SIZE) this.ring.splice(0, this.ring.length - RING_SIZE)
    this.emit('line', line)
  }

  query(q: LogQuery = {}): LogLine[] {
    const search = q.search?.toLowerCase()
    const out = this.ring.filter((l) => {
      if (q.since !== undefined && l.id <= q.since) return false
      if (q.sources?.length && !q.sources.includes(l.source)) return false
      if (q.levels?.length && !q.levels.includes(l.level)) return false
      if (search && !l.message.toLowerCase().includes(search)) return false
      return true
    })
    const limit = q.limit ?? 1000
    return out.slice(-limit)
  }

  knownSources(): string[] {
    return [...this.sources].sort()
  }

  clear(): void {
    this.ring.length = 0
  }
}

export function detectLevel(message: string): LogLevel {
  for (const [level, pattern] of LEVEL_PATTERNS) {
    if (pattern.test(message)) return level
  }
  return 'unknown'
}

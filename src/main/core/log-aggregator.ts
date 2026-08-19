import { EventEmitter } from 'node:events'
import { createReadStream, existsSync, statSync, watch, type FSWatcher } from 'node:fs'
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
      if (src.kind !== 'file' || !src.path) continue
      this.tailFile(sourceId, src.label ?? src.path, src.path)
    }
  }

  detach(sourceId: string): void {
    for (const [key, entry] of this.watchers) {
      if (key.startsWith(`${sourceId}::`)) {
        entry.watcher.close()
        this.watchers.delete(key)
      }
    }
  }

  private tailFile(sourceId: string, label: string, path: string): void {
    const key = `${sourceId}::${path}`
    if (this.watchers.has(key) || !existsSync(path)) return

    const offset = statSync(path).size
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

import { spawn, type ChildProcess } from 'node:child_process'
import { EventEmitter } from 'node:events'
import { randomUUID } from 'node:crypto'
import type { ProcessHandle, ResourceUsage, SpawnRequest } from '../../shared/process.js'
import type { PortAllocator } from './port-allocator.js'

interface Managed {
  handle: ProcessHandle
  child: ChildProcess | null
}

/**
 * The only place in the app that spawns anything. Routing every process through
 * here is what gives us lifecycle control, stable port allocation, and free log
 * aggregation — dev-server stdout flows into the log viewer with no extra work.
 */
export class ProcessManager extends EventEmitter {
  private readonly processes = new Map<string, Managed>()
  private usageTimer: NodeJS.Timeout | null = null

  constructor(private readonly ports: PortAllocator) {
    super()
  }

  async spawn(req: SpawnRequest): Promise<ProcessHandle> {
    const id = randomUUID()
    const env: Record<string, string> = {
      ...(process.env as Record<string, string>),
      ...(req.env ?? {})
    }

    let port: number | null = null
    if (req.portEnvVar) {
      port = await this.ports.allocate(`${req.owner.kind}:${req.owner.id}`, req.preferredPort)
      env[req.portEnvVar] = String(port)
    }

    const handle: ProcessHandle = {
      id,
      owner: req.owner,
      label: req.label,
      pid: null,
      state: 'starting',
      command: req.command,
      args: req.args ?? [],
      cwd: req.cwd ?? null,
      port,
      startedAt: Date.now(),
      exitedAt: null,
      exitCode: null,
      restarts: 0
    }

    const child = spawn(req.command, req.args ?? [], {
      cwd: req.cwd,
      env,
      // A login shell is not used: commands are resolved to absolute binaries by
      // the callers (see resolve-binary.ts) so we never depend on the user's PATH.
      shell: false,
      stdio: ['ignore', 'pipe', 'pipe']
    })

    const managed: Managed = { handle, child }
    this.processes.set(id, managed)

    child.on('spawn', () => {
      handle.pid = child.pid ?? null
      handle.state = 'running'
      this.emit('changed', { ...handle })
    })

    this.pipe(child, handle, 'stdout')
    this.pipe(child, handle, 'stderr')

    child.on('error', (err) => {
      handle.state = 'crashed'
      handle.exitedAt = Date.now()
      this.emit('log', { handle, stream: 'stderr', chunk: `${err.message}\n` })
      this.emit('changed', { ...handle })
    })

    child.on('exit', (code) => {
      handle.exitCode = code
      handle.exitedAt = Date.now()
      handle.pid = null
      handle.state = handle.state === 'stopping' || code === 0 ? 'stopped' : 'crashed'
      managed.child = null
      this.emit('changed', { ...handle })
    })

    // Settle on the first spawn/error so the returned handle reflects reality.
    // Returning eagerly reported `starting` for a process that had in fact
    // already failed with ENOENT, and callers had no way to notice.
    await new Promise<void>((resolve, reject) => {
      const onSpawn = (): void => {
        child.off('error', onError)
        resolve()
      }
      const onError = (err: Error): void => {
        child.off('spawn', onSpawn)
        reject(new Error(`Failed to start "${req.command}": ${err.message}`))
      }
      child.once('spawn', onSpawn)
      child.once('error', onError)
    })

    return { ...handle }
  }

  private pipe(child: ChildProcess, handle: ProcessHandle, stream: 'stdout' | 'stderr'): void {
    const src = stream === 'stdout' ? child.stdout : child.stderr
    src?.setEncoding('utf8')
    src?.on('data', (chunk: string) => {
      this.emit('log', { handle, stream, chunk })
    })
  }

  get(id: string): ProcessHandle | null {
    const m = this.processes.get(id)
    return m ? { ...m.handle } : null
  }

  list(): ProcessHandle[] {
    return [...this.processes.values()].map((m) => ({ ...m.handle }))
  }

  /**
   * The owner's live process. `includeDead` also returns a handle whose child
   * has exited, which is what lets callers distinguish "never started" from
   * "started and crashed".
   */
  findByOwner(kind: string, ownerId: string, includeDead = false): ProcessHandle | null {
    let dead: ProcessHandle | null = null
    for (const m of this.processes.values()) {
      if (m.handle.owner.kind !== kind || m.handle.owner.id !== ownerId) continue
      if (m.child) return { ...m.handle }
      if (includeDead) dead = { ...m.handle }
    }
    return dead
  }

  /** SIGTERM, then SIGKILL after `graceMs`. */
  async stop(id: string, graceMs = 5000): Promise<void> {
    const managed = this.processes.get(id)
    if (!managed?.child) return
    const child = managed.child
    managed.handle.state = 'stopping'
    this.emit('changed', { ...managed.handle })

    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        if (!child.killed) child.kill('SIGKILL')
        resolve()
      }, graceMs)
      child.once('exit', () => {
        clearTimeout(timer)
        resolve()
      })
      child.kill('SIGTERM')
    })
  }

  async stopAll(): Promise<void> {
    await Promise.all([...this.processes.keys()].map((id) => this.stop(id, 2000)))
  }

  /**
   * Kill processes left behind by a previous Harbor that did not shut down
   * cleanly — a force-quit, a crash, a `pkill` of the app.
   *
   * They are identified by Harbor's own home directory appearing in their
   * argv, so this can only ever match something Harbor started: a dnsmasq or
   * php-fpm pointed at a config under ~/.harbor. An orphan still holds its
   * port and socket, so the next launch fails to bind with no obvious cause.
   */
  static async reclaimOrphans(harborHome: string): Promise<number> {
    const listing = await new Promise<string>((resolve) => {
      const ps = spawn('/bin/ps', ['-Ao', 'pid=,args='])
      let buf = ''
      ps.stdout.setEncoding('utf8')
      ps.stdout.on('data', (c: string) => (buf += c))
      ps.on('error', () => resolve(''))
      ps.on('close', () => resolve(buf))
    })

    let killed = 0
    for (const line of listing.split('\n')) {
      const trimmed = line.trim()
      if (!trimmed.includes(harborHome)) continue
      // Only the daemons Harbor runs against its own config, never editors or
      // shells that merely mention the path.
      if (!/\b(dnsmasq|php-fpm)\b/.test(trimmed)) continue

      const pid = Number(trimmed.split(/\s+/)[0])
      if (!Number.isFinite(pid) || pid === process.pid) continue
      try {
        process.kill(pid, 'SIGTERM')
        killed++
      } catch {
        /* already gone, or not ours to kill */
      }
    }
    return killed
  }

  /** Poll `ps` for CPU/RSS. Kafka and Elasticsearch make this worth surfacing. */
  startUsagePolling(intervalMs = 4000): void {
    if (this.usageTimer) return
    this.usageTimer = setInterval(() => {
      // Emit even when empty. Suppressing the empty case left the last
      // non-zero reading on screen after everything stopped, which reads as a
      // stuck meter rather than an idle one.
      void this.sampleUsage().then((samples) => this.emit('usage', samples))
    }, intervalMs)
  }

  stopUsagePolling(): void {
    if (this.usageTimer) clearInterval(this.usageTimer)
    this.usageTimer = null
  }

  async sampleUsage(): Promise<ResourceUsage[]> {
    const live = [...this.processes.values()].filter((m) => m.handle.pid)
    if (!live.length) return []
    const pids = live.map((m) => m.handle.pid as number)
    const out = await psStats(pids)
    const now = Date.now()
    return live.flatMap((m) => {
      const stat = out.get(m.handle.pid as number)
      if (!stat) return []
      return [
        {
          processId: m.handle.id,
          pid: m.handle.pid as number,
          cpu: stat.cpu,
          memory: stat.rss * 1024,
          sampledAt: now
        }
      ]
    })
  }
}

function psStats(pids: number[]): Promise<Map<number, { cpu: number; rss: number }>> {
  return new Promise((resolve) => {
    const ps = spawn('/bin/ps', ['-o', 'pid=,pcpu=,rss=', '-p', pids.join(',')])
    let buf = ''
    ps.stdout.setEncoding('utf8')
    ps.stdout.on('data', (c: string) => (buf += c))
    ps.on('error', () => resolve(new Map()))
    ps.on('close', () => {
      const map = new Map<number, { cpu: number; rss: number }>()
      for (const line of buf.trim().split('\n')) {
        const [pid, cpu, rss] = line.trim().split(/\s+/)
        if (!pid) continue
        map.set(Number(pid), { cpu: Number(cpu ?? 0), rss: Number(rss ?? 0) })
      }
      resolve(map)
    })
  })
}

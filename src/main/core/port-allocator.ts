import { createServer } from 'node:net'
import type { ConfigStore } from './config-store.js'

const RANGE_START = 3100
const RANGE_END = 3999

/** How far above a preferred port to look before falling back to the pool. */
const NEAR_SPAN = 100

export interface AllocateOptions {
  /** First choice — a project's last port, or a service's canonical one. */
  preferred?: number
  /**
   * Scan upward from `preferred` before the shared pool, so a second MySQL
   * lands on 3307 rather than 3142. Purely cosmetic, but a port a user can
   * recognise is worth a few lines.
   */
  near?: boolean
  /**
   * Return a stored assignment without checking it is free.
   *
   * The default liveness check exists for dev-server ports, which are allocated
   * just before spawning — a port taken while Harbor was closed must not be
   * handed out. It is exactly wrong for a service instance: a *running*
   * instance is itself what makes its port not-free, so re-allocating would
   * quietly move a live database to a different port and leave every `.env`
   * that referenced it pointing at nothing.
   */
  sticky?: boolean
}

/**
 * Stable port assignment. The whole point is persistence: `api.test` must keep
 * the same `proxy_pass` port across restarts, or every nginx vhost has to be
 * rewritten on boot. Retrofitting this later is painful, so it exists from day
 * one and every reverse-proxy project goes through it.
 */
export class PortAllocator {
  constructor(private readonly store: ConfigStore) {}

  /** Port already assigned to this key, if any. */
  peek(key: string): number | null {
    return this.store.get().ports[key] ?? null
  }

  /**
   * Returns the persisted assignment when it is still usable. A stored port can
   * be stolen while Harbor is closed — by a manually started dev server, or by
   * another tool — and handing it back would produce an nginx vhost pointing at
   * someone else's process. Callers re-render the vhost when the port changes.
   */
  async allocate(key: string, options: AllocateOptions | number = {}): Promise<number> {
    const { preferred, near = false, sticky = false } =
      typeof options === 'number' ? { preferred: options } : options

    const existing = this.store.get().ports[key]
    if (existing) {
      if (sticky || (await isFree(existing))) return existing
      this.store.update((s) => {
        delete s.ports[key]
      })
    }

    const taken = new Set(Object.values(this.store.get().ports))
    const candidates: number[] = []
    if (preferred && !taken.has(preferred)) candidates.push(preferred)
    if (preferred && near) {
      for (let p = preferred + 1; p <= preferred + NEAR_SPAN; p++) {
        if (!taken.has(p)) candidates.push(p)
      }
    }
    for (let p = RANGE_START; p <= RANGE_END; p++) {
      if (!taken.has(p) && !candidates.includes(p)) candidates.push(p)
    }

    for (const port of candidates) {
      if (await isFree(port)) {
        this.store.update((s) => {
          s.ports[key] = port
        })
        return port
      }
    }
    throw new Error(
      `No free port available in ${RANGE_START}-${RANGE_END}. ` +
        `Stop something using that range, or free the ports Harbor has already assigned.`
    )
  }

  release(key: string): void {
    this.store.update((s) => {
      delete s.ports[key]
    })
  }

  /**
   * Release every assignment under a prefix. Forgetting a project has to give
   * back its site port and every port its service stack held, and those are
   * separate keys — without this they leak, and the pool never recovers.
   */
  releasePrefix(prefix: string): string[] {
    const released = Object.keys(this.store.get().ports).filter((k) => k.startsWith(prefix))
    if (!released.length) return []
    this.store.update((s) => {
      for (const key of released) delete s.ports[key]
    })
    return released
  }
}

export function isFree(port: number, host = '127.0.0.1'): Promise<boolean> {
  return new Promise((resolve) => {
    const server = createServer()
    server.once('error', () => resolve(false))
    server.once('listening', () => server.close(() => resolve(true)))
    server.listen(port, host)
  })
}

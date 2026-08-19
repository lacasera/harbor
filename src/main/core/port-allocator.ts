import { createServer } from 'node:net'
import type { ConfigStore } from './config-store.js'

const RANGE_START = 3100
const RANGE_END = 3999

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
  async allocate(key: string, preferred?: number): Promise<number> {
    const existing = this.store.get().ports[key]
    if (existing) {
      if (await isFree(existing)) return existing
      this.store.update((s) => {
        delete s.ports[key]
      })
    }

    const taken = new Set(Object.values(this.store.get().ports))
    const candidates: number[] = []
    if (preferred && !taken.has(preferred)) candidates.push(preferred)
    for (let p = RANGE_START; p <= RANGE_END; p++) {
      if (!taken.has(p)) candidates.push(p)
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
}

export function isFree(port: number, host = '127.0.0.1'): Promise<boolean> {
  return new Promise((resolve) => {
    const server = createServer()
    server.once('error', () => resolve(false))
    server.once('listening', () => server.close(() => resolve(true)))
    server.listen(port, host)
  })
}

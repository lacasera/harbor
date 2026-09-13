import { EventEmitter } from 'node:events'
import { randomUUID } from 'node:crypto'
import type { Notice, NoticeInput } from '../../shared/notice.js'

/**
 * Raises user-facing notices. Two delivery paths, because the window does not
 * exist yet while `HarborApp.start()` runs: every notice is emitted live (for a
 * renderer that is already listening) *and* buffered so a renderer mounting
 * afterwards can drain what it missed. The renderer dedupes by `id`, so a
 * notice caught by both paths is shown once.
 */
export class Notifier extends EventEmitter {
  private readonly pending: Notice[] = []
  /** A backstop against an unbounded buffer if nothing ever drains it. */
  private static readonly MAX_PENDING = 50

  notify(input: NoticeInput): Notice {
    const notice: Notice = { id: randomUUID(), createdAt: Date.now(), ...input }
    this.pending.push(notice)
    if (this.pending.length > Notifier.MAX_PENDING) this.pending.shift()
    this.emit('notice', notice)
    return notice
  }

  /** Everything buffered so far, cleared so each notice drains only once. */
  drain(): Notice[] {
    return this.pending.splice(0, this.pending.length)
  }
}

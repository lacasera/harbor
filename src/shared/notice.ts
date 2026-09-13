export type NoticeLevel = 'info' | 'warn' | 'error'

/**
 * A one-off message for the user, shown as a toast. Deliberately thin: the
 * renderer keeps no history beyond what is on screen, so anything worth finding
 * later is also written to the log aggregator by whoever raised the notice.
 */
export interface Notice {
  /** Stable id so the renderer can dedupe a notice that arrives both from the
   *  boot drain and the live push, and dismiss it by key. */
  id: string
  level: NoticeLevel
  title: string
  message?: string
  /** Origin tag — a project or service id — for future filtering/grouping. */
  source?: string
  createdAt: number
}

/** What a caller supplies; the Notifier fills in id and createdAt. */
export type NoticeInput = Omit<Notice, 'id' | 'createdAt'>

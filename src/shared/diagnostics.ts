export type DiagnosticStatus = 'ok' | 'warn' | 'fail'

/**
 * One thing Harbor needs, and whether it is there.
 *
 * `required` separates "Harbor cannot serve a site" from "a feature is
 * unavailable": no Docker means no databases, which is worth saying, but it is
 * not a broken installation. Conflating the two trains people to ignore the
 * list.
 */
export interface Diagnostic {
  id: string
  label: string
  status: DiagnosticStatus
  /** What was found. */
  detail: string
  /** What to do about it. Absent when there is nothing to do. */
  remedy?: string
  required: boolean
}

import { useEffect, useRef, useState } from 'react'
import type { Notice } from '../../../shared/notice.js'
import { invoke, subscribe } from '../ipc/client.js'

/** How long a non-error toast lingers before dismissing itself. Errors stay
 *  until the user closes them — a port conflict is worth reading. */
const AUTO_DISMISS_MS = 7000

/**
 * The app's only toast surface. Notices raised before this window existed —
 * boot-time port conflicts, chiefly — are drained once on mount; anything after
 * arrives on the live `notice` push. Both paths dedupe by id, so a notice that
 * lands in both is shown once.
 */
export function Toasts(): React.JSX.Element {
  const [notices, setNotices] = useState<Notice[]>([])
  // Every id ever seen, so a drained notice that also arrives live isn't shown
  // twice — and a dismissed one never pops back on the next push.
  const seen = useRef<Set<string>>(new Set())

  const add = (incoming: Notice[]): void => {
    const fresh = incoming.filter((n) => !seen.current.has(n.id))
    if (!fresh.length) return
    fresh.forEach((n) => seen.current.add(n.id))
    setNotices((prev) => [...prev, ...fresh])
  }

  useEffect(() => {
    void invoke('notices:drain').then(add)
    return subscribe('notice', (n) => add([n]))
  }, [])

  const dismiss = (id: string): void => setNotices((prev) => prev.filter((n) => n.id !== id))

  if (!notices.length) return <></>
  return (
    <div className="toasts">
      {notices.map((n) => (
        <ToastCard key={n.id} notice={n} onDismiss={() => dismiss(n.id)} />
      ))}
    </div>
  )
}

function ToastCard({
  notice,
  onDismiss
}: {
  notice: Notice
  onDismiss: () => void
}): React.JSX.Element {
  useEffect(() => {
    if (notice.level === 'error') return
    const timer = setTimeout(onDismiss, AUTO_DISMISS_MS)
    return () => clearTimeout(timer)
    // onDismiss is stable enough for this row's lifetime; keying off the id
    // keeps the timer tied to this specific notice.
  }, [notice.id, notice.level])

  return (
    <div className={`toast ${notice.level}`} role="alert">
      <div className="toast-body">
        <div className="toast-title">{notice.title}</div>
        {notice.message && <div className="toast-message">{notice.message}</div>}
      </div>
      <button type="button" className="toast-close" aria-label="Dismiss" onClick={onDismiss}>
        ×
      </button>
    </div>
  )
}

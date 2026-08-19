import { useState } from 'react'
import { invoke } from '../ipc/client.js'

/**
 * A link that opens in the user's browser.
 *
 * Still a real anchor — the href shows on hover, and it can be copied — but the
 * click goes through IPC rather than relying on the main process intercepting
 * an anchor's navigation. That interception only ever covered `target="_blank"`,
 * and when it failed it failed silently: the click did nothing and said nothing.
 * Here a failure has somewhere to appear.
 */
export function ExternalLink({
  href,
  className,
  style,
  title,
  children
}: {
  href: string
  className?: string
  style?: React.CSSProperties
  title?: string
  children: React.ReactNode
}): React.JSX.Element {
  const [error, setError] = useState<string | null>(null)

  return (
    <a
      href={href}
      className={className}
      style={style}
      title={error ?? title ?? href}
      onClick={(e) => {
        e.preventDefault()
        e.stopPropagation()
        setError(null)
        void invoke('app:openExternal', href).catch((err: Error) => setError(err.message))
      }}
    >
      {children}
      {error && <span className="field-error"> — {error}</span>}
    </a>
  )
}

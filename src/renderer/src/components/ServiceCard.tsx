import { useState } from 'react'
import type { ServiceDescriptor } from '../../../shared/service.js'
import { invoke } from '../ipc/client.js'
import { ConfigForm } from './ConfigForm.js'
import { EnvPreview } from './EnvPreview.js'

/**
 * One card renders every service. Nothing here branches on a service id — the
 * driver's metadata supplies the name, ports, form and .env block.
 */
export function ServiceCard({
  service,
  onChanged
}: {
  service: ServiceDescriptor
  onChanged: (next: ServiceDescriptor) => void
}): React.JSX.Element {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [open, setOpen] = useState(false)

  const running = service.status.health === 'running'

  const run = async (fn: () => Promise<ServiceDescriptor | void>): Promise<void> => {
    setBusy(true)
    setError(null)
    try {
      const next = await fn()
      if (next) onChanged(next)
    } catch (err) {
      setError((err as Error).message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <article className="card">
      <header className="card-head">
        <div>
          <h3>{service.displayName}</h3>
          <p className="muted">{service.description}</p>
        </div>
        <span className={`badge ${service.status.health}`}>{service.status.health}</span>
      </header>

      <dl className="meta">
        <div>
          <dt>Backend</dt>
          <dd>{service.backend}</dd>
        </div>
        <div>
          <dt>Ports</dt>
          <dd>{(service.status.ports.length ? service.status.ports : service.defaultPorts).join(', ')}</dd>
        </div>
        <div>
          <dt>Installed</dt>
          <dd>{service.installed ? service.installedVersions.join(', ') : 'not installed'}</dd>
        </div>
      </dl>

      {service.status.detail && <p className="muted">{service.status.detail}</p>}
      {(error ?? service.status.error) && (
        <p className="error">{error ?? service.status.error}</p>
      )}

      <div className="card-actions">
        {!service.installed && (
          <button
            type="button"
            className="btn"
            disabled={busy}
            onClick={() => void run(() => invoke('services:install', service.id, 'latest'))}
          >
            Install
          </button>
        )}
        <button
          type="button"
          className="btn primary"
          disabled={busy || !service.installed}
          onClick={() =>
            void run(() =>
              running ? invoke('services:stop', service.id) : invoke('services:start', service.id)
            )
          }
        >
          {running ? 'Stop' : 'Start'}
        </button>
        <button type="button" className="btn ghost" onClick={() => setOpen((o) => !o)}>
          {open ? 'Hide settings' : 'Settings'}
        </button>
      </div>

      {open && (
        <div className="card-body">
          <ConfigForm
            schema={service.configSchema}
            values={service.config.values}
            disabled={busy}
            onSave={(values) =>
              void run(() => invoke('services:updateConfig', service.id, { values }))
            }
          />
          <EnvPreview serviceId={service.id} />
        </div>
      )}
    </article>
  )
}

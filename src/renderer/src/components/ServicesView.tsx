import { useMemo, useState } from 'react'
import type { ServiceDescriptor } from '../../../shared/service.js'
import type { ResourceUsage } from '../../../shared/process.js'
import { invoke } from '../ipc/client.js'
import {
  StatusDot,
  Toggle,
  formatBytes,
  monogramsFor,
  statusOf,
  tintFor
} from './primitives.js'

export function ServicesView({
  services,
  usage,
  onOpen,
  onChanged
}: {
  services: ServiceDescriptor[]
  usage: ResourceUsage[]
  onOpen: (id: string) => void
  onChanged: (next: ServiceDescriptor) => void
}): React.JSX.Element {
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const monograms = useMemo(
    () => monogramsFor(services.map((s) => s.displayName)),
    [services]
  )

  const run = async (id: string, fn: () => Promise<ServiceDescriptor | void>): Promise<void> => {
    setBusy(id)
    setError(null)
    try {
      const next = await fn()
      if (next) onChanged(next)
    } catch (err) {
      setError((err as Error).message)
    } finally {
      setBusy(null)
    }
  }

  const running = services.filter((s) => s.status.health === 'running').length
  const installed = services.filter((s) => s.installed).length

  return (
    <>
      <div className="page-head">
        <div>
          <div className="page-title">Services</div>
          <div className="page-sub">
            {running} running · {installed} installed · {services.length} in catalog
          </div>
        </div>
        <div className="hstack">
          <button
            type="button"
            className="btn"
            disabled={!running}
            onClick={() =>
              void Promise.all(
                services
                  .filter((s) => s.status.health === 'running')
                  .map((s) => run(s.id, () => invoke('services:stop', s.id)))
              )
            }
          >
            Stop all
          </button>
        </div>
      </div>

      <div className="page-body">
        {error && <p className="error-text">{error}</p>}

        {!services.length ? (
          <div className="empty">
            <h3>No services installed</h3>
            <p>
              Install a service and Harbor manages its binary, ports and credentials — then hands
              you the env vars your projects need.
            </p>
          </div>
        ) : (
          <div className="service-grid">
            {services.map((service) => {
              const status = statusOf(service.status.health)
              const sample = usage.find((u) => u.processId.startsWith(service.id))
              const ports = service.status.ports.length
                ? service.status.ports
                : service.defaultPorts

              return (
                <div
                  key={service.id}
                  className="service-card"
                  role="button"
                  tabIndex={0}
                  onClick={() => onOpen(service.id)}
                  onKeyDown={(e) => e.key === 'Enter' && onOpen(service.id)}
                >
                  <div className="top">
                    <div className="svc-mono" style={{ background: tintFor(service.id) }}>
                      {monograms.get(service.displayName)}
                    </div>
                    <div className="meta">
                      <div className="title">
                        <span>{service.displayName}</span>
                        <span className="mono small muted">{service.config.version}</span>
                      </div>
                      <div className="desc">{service.description}</div>
                    </div>

                    {service.installed ? (
                      <Toggle
                        on={status === 'running'}
                        label={`Toggle ${service.displayName}`}
                        disabled={busy === service.id}
                        onChange={(on) =>
                          void run(service.id, () =>
                            on
                              ? invoke('services:start', service.id)
                              : invoke('services:stop', service.id)
                          )
                        }
                      />
                    ) : (
                      <button
                        type="button"
                        className="btn outline-ac"
                        disabled={busy === service.id}
                        onClick={(e) => {
                          e.stopPropagation()
                          void run(service.id, () =>
                            invoke('services:install', service.id, 'latest')
                          )
                        }}
                      >
                        {busy === service.id ? 'Installing…' : 'Install'}
                      </button>
                    )}
                  </div>

                  <div className="foot">
                    <span className="hstack" style={{ gap: 6 }}>
                      <StatusDot status={busy === service.id ? 'busy' : status} />
                      {busy === service.id
                        ? 'Working…'
                        : status === 'running'
                          ? 'Running'
                          : service.installed
                            ? 'Stopped'
                            : 'Not installed'}
                    </span>
                    <span className="mono small muted">:{ports.join(', ')}</span>
                    <div className="grow" />
                    <span className="mono small muted">
                      {sample ? `${sample.cpu.toFixed(1)}%` : '—'}
                    </span>
                    <span className="mono small muted">
                      {sample ? formatBytes(sample.memory) : '—'}
                    </span>
                  </div>
                </div>
              )
            })}
          </div>
        )}
      </div>
    </>
  )
}

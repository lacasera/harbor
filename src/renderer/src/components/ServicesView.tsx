import { useMemo, useState } from 'react'
import type { ServiceDescriptor, ServiceInstanceDescriptor } from '../../../shared/service.js'
import { invoke } from '../ipc/client.js'
import { StatusDot } from './primitives.js'
import { ServiceIcon } from './ServiceIcon.js'

/**
 * The service catalogue: what each service is, and how many projects use it.
 *
 * Services are no longer things that run — instances are. A card here is a
 * catalogue entry, so it says how much a service is used and nothing more.
 * Starting, configuring and connecting to one happens on the project that owns
 * it, because that is the only place the question "which MySQL?" has an answer.
 */
export function ServicesView({
  services,
  onOpen,
  onChanged
}: {
  services: ServiceDescriptor[]
  onOpen: (id: string) => void
  onChanged: (next: ServiceInstanceDescriptor) => void
}): React.JSX.Element {
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const names = useMemo(() => services.map((s) => s.displayName), [services])
  const run = async (
    key: string,
    fn: () => Promise<ServiceInstanceDescriptor | void>
  ): Promise<void> => {
    setBusy(key)
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

  const instances = services.flatMap((s) => s.instances)
  const running = instances.filter((i) => i.status.health === 'running')

  return (
    <>
      <div className="page-head">
        <div>
          <div className="page-title">Services</div>
          <div className="page-sub">
            {running.length} running · {instances.length} attached · {services.length} in catalog
          </div>
        </div>
        <div className="hstack">
          <button
            type="button"
            className="btn"
            disabled={!running.length}
            onClick={() =>
              void Promise.all(
                running.map((i) =>
                  run(i.key, () =>
                    invoke('services:stop', { owner: i.owner, serviceId: i.serviceId })
                  )
                )
              )
            }
          >
            Stop all
          </button>
        </div>
      </div>

      <div className="page-body">
        {error && <p className="error-text">{error}</p>}

        <div className="service-grid">
          {services.map((service) => {
            const usedBy = service.instances.length
            const up = service.instances.filter((i) => i.status.health === 'running').length
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
                  <ServiceIcon
                    id={service.id}
                    displayName={service.displayName}
                    icon={service.icon}
                    tint={service.tint}
                    catalogue={names}
                  />
                  <div className="meta">
                    <div className="title">
                      <span>{service.displayName}</span>
                      <span className="mono small muted">
                        {service.installedVersions[0] ?? 'latest'}
                      </span>
                    </div>
                    <div className="desc">{service.description}</div>
                  </div>

                  {!service.installed && (
                    <button
                      type="button"
                      className="btn outline-ac"
                      disabled={busy === service.id}
                      onClick={(e) => {
                        e.stopPropagation()
                        void run(service.id, async () => {
                          await invoke('services:install', service.id, 'latest')
                        })
                      }}
                    >
                      {busy === service.id ? 'Installing…' : 'Install'}
                    </button>
                  )}
                </div>

                {/*
                    A count, not a list of names. A service can be used by any
                    number of projects, and naming them made the card grow with
                    the list — three projects and the grid was ragged, ten and it
                    was unusable. Which projects, and their individual ports and
                    controls, are on the service's own page.
                */}
                <div className="foot">
                  <span className="hstack" style={{ gap: 6 }}>
                    <StatusDot status={up ? 'running' : 'stopped'} />
                    {usedBy
                      ? `${usedBy} project${usedBy === 1 ? '' : 's'} · ${up} running`
                      : 'Not used by any project'}
                  </span>
                  <div className="grow" />
                  <span className="mono small muted">:{service.defaultPorts.join(', ')}</span>
                </div>
              </div>
            )
          })}
        </div>
      </div>
    </>
  )
}

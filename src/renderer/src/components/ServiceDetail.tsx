import { useMemo, useState } from 'react'
import type { ServiceDescriptor, ServiceInstanceDescriptor } from '../../../shared/service.js'
import type { ProjectDescriptor } from '../../../shared/project.js'
import type { LogLine } from '../../../shared/logs.js'
import type { ProcessHandle, ResourceUsage } from '../../../shared/process.js'
import { invoke } from '../ipc/client.js'
import { StatusDot, statusOf } from './primitives.js'
import { ServiceIcon } from './ServiceIcon.js'
import { ServiceInstancePanel } from './ServiceInstancePanel.js'

/**
 * Catalogue detail: what this service is, and every instance of it.
 *
 * A service has no config or status of its own any more — a project's MySQL and
 * another project's MySQL are separate servers with separate ports, credentials
 * and data. So this page picks an instance and hands it to the shared panel,
 * and offers to give a project one where none exists.
 */
export function ServiceDetail({
  service,
  catalogue,
  projects,
  processes,
  usage,
  logs,
  onBack,
  onChanged,
  onCatalogueChanged,
  onOpenLogs
}: {
  service: ServiceDescriptor
  /** The whole catalogue, so this tile's monogram matches the grid's. */
  catalogue: ServiceDescriptor[]
  projects: ProjectDescriptor[]
  processes: ProcessHandle[]
  usage: ResourceUsage[]
  logs: LogLine[]
  onBack: () => void
  onChanged: (next: ServiceInstanceDescriptor) => void
  onCatalogueChanged: (next: ServiceDescriptor[]) => void
  onOpenLogs: () => void
}): React.JSX.Element {
  const [selected, setSelected] = useState<string | null>(null)
  const [addTo, setAddTo] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const names = useMemo(() => catalogue.map((s) => s.displayName), [catalogue])
  const ownerNames = useMemo(() => new Map(projects.map((p) => [p.id, p.name])), [projects])

  const active =
    service.instances.find((i) => i.key === selected) ?? service.instances[0] ?? null
  const unattached = projects.filter(
    (p) => !service.instances.some((i) => i.owner === p.id)
  )

  const attach = async (projectId: string): Promise<void> => {
    setBusy(true)
    setError(null)
    try {
      onCatalogueChanged(await invoke('projects:attachService', projectId, service.id))
      setAddTo('')
    } catch (err) {
      setError((err as Error).message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <>
      <div className="detail-head">
        <button type="button" className="back" onClick={onBack}>
          ‹ Services
        </button>

        <div className="hstack" style={{ gap: 12, flexWrap: 'nowrap', marginTop: 8 }}>
          <ServiceIcon
            id={service.id}
            displayName={service.displayName}
            icon={service.icon}
            tint={service.tint}
            catalogue={names}
            size={40}
          />
          <div>
            <div className="hstack" style={{ gap: 9 }}>
              <span className="page-title">{service.displayName}</span>
              <span className="mono small muted">{service.backend}</span>
            </div>
            <div className="page-sub">{service.description}</div>
          </div>
          <div className="grow" />
          <div className="hstack">
            {service.defaultPorts.map((port) => (
              <span
                key={port}
                className="pill mono"
                style={{ height: 26, padding: '0 9px', fontSize: 11.5 }}
              >
                :{port}
              </span>
            ))}
          </div>
        </div>
      </div>

      <div className="page-body" style={{ paddingTop: 20 }}>
        {error && <p className="error-text">{error}</p>}

        <div className="card card-pad">
          <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 8 }}>
            Used by {service.instances.length} project
            {service.instances.length === 1 ? '' : 's'}
          </div>
          <div className="hstack" style={{ gap: 8, flexWrap: 'wrap' }}>
            {service.instances.map((instance) => (
              <button
                key={instance.key}
                type="button"
                className={`btn ${active?.key === instance.key ? 'primary' : ''}`}
                onClick={() => setSelected(instance.key)}
              >
                <StatusDot status={statusOf(instance.status.health)} />
                {ownerNames.get(instance.owner) ?? instance.owner}
              </button>
            ))}
            {!service.instances.length && (
              <span className="small muted">
                No project uses {service.displayName} yet. Give one its own instance — it gets its
                own port, credentials and data.
              </span>
            )}
          </div>

          {/*
              A picker, not a button per project. Every project on the machine
              is eligible, so buttons made this row grow without limit — the
              same reason the catalogue cards show a count rather than names.
          */}
          {unattached.length > 0 && (
            <div className="hstack" style={{ gap: 8, marginTop: 12 }}>
              <span className="small muted">Add to</span>
              <select
                className="field-select"
                style={{ maxWidth: 260 }}
                value={addTo}
                onChange={(e) => setAddTo(e.target.value)}
              >
                <option value="">Choose a project…</option>
                {unattached.map((project) => (
                  <option key={project.id} value={project.id}>
                    {project.name}
                  </option>
                ))}
              </select>
              <button
                type="button"
                className="btn outline-ac"
                disabled={busy || !addTo}
                onClick={() => void attach(addTo)}
              >
                {busy ? 'Adding…' : 'Add'}
              </button>
            </div>
          )}
        </div>

        {active && (
          <div style={{ marginTop: 16 }}>
            <ServiceInstancePanel
              instance={active}
              ownerLabel={ownerNames.get(active.owner) ?? active.owner}
              catalogueNames={names}
              processes={processes}
              usage={usage}
              logs={logs}
              onChanged={onChanged}
              onOpenLogs={onOpenLogs}
            />
          </div>
        )}
      </div>
    </>
  )
}

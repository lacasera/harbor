import { useEffect, useState } from 'react'
import type {
  EnvBlock as EnvBlockData,
  FieldError,
  ServiceInstanceDescriptor
} from '../../../shared/service.js'
import type { LogLine } from '../../../shared/logs.js'
import type { ProcessHandle, ResourceUsage } from '../../../shared/process.js'
import { invoke } from '../ipc/client.js'
import { StatusDot, formatBytes, statusOf, useCopy, usageForOwner } from './primitives.js'
import { ServiceIcon } from './ServiceIcon.js'
import { EnvLines, toRows, toText } from './EnvBlock.js'
import { SchemaForm } from './SchemaForm.js'
import { LogRows } from './LogsView.js'
import { ExternalLink } from './ExternalLink.js'

/**
 * Everything you can do to ONE service instance: configure it, read its live
 * `.env` block, watch its logs, start and stop it.
 *
 * Deliberately tab-free. This panel already sits inside a tab (the project's
 * Services tab, or the catalogue page), and a second row of tabs inside it
 * hides two thirds of an instance behind a click while looking like navigation
 * for the page. The three things you want are short enough to stack: a header
 * that says what state it is in, the form, then the `.env` and logs as
 * collapsible strips under it.
 */
export function ServiceInstancePanel({
  instance,
  ownerLabel,
  catalogueNames,
  processes,
  usage,
  logs,
  pinHeader = false,
  onChanged,
  onDetach,
  onOpenLogs
}: {
  instance: ServiceInstanceDescriptor
  /** Whose instance this is, e.g. the project name. */
  ownerLabel: string
  /** Every service's display name, so the monogram fallback stays consistent. */
  catalogueNames: string[]
  processes: ProcessHandle[]
  usage: ResourceUsage[]
  logs: LogLine[]
  /**
   * Pin the header while the form scrolls under it. Only correct when this
   * panel is the top of its own scrolling column: the pinned header paints the
   * strip above itself to hide rows passing through it, which would paint over
   * anything else that happened to be up there.
   */
  pinHeader?: boolean
  onChanged: (next: ServiceInstanceDescriptor) => void
  onDetach?: () => void
  onOpenLogs?: () => void
}): React.JSX.Element {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [block, setBlock] = useState<EnvBlockData | null>(null)
  const [fieldErrors, setFieldErrors] = useState<FieldError[]>([])
  const [showLogs, setShowLogs] = useState(false)
  const { copied, copy } = useCopy()

  const ref = { owner: instance.owner, serviceId: instance.serviceId }

  useEffect(() => {
    let cancelled = false
    void invoke('services:envBlock', ref).then((result) => {
      if (!cancelled) setBlock(result)
    })
    return () => {
      cancelled = true
    }
    // Re-resolved whenever the values behind the templates can have moved.
  }, [instance.key, instance.status.health, instance.values])

  /** Validation failure is an expected result here, not an exception. */
  const saveConfig = async (values: Record<string, unknown>): Promise<void> => {
    setBusy(true)
    setError(null)
    try {
      const result = await invoke('services:updateConfig', ref, { values })
      if (result.ok) {
        setFieldErrors([])
        onChanged(result.instance)
      } else {
        setFieldErrors(result.errors)
      }
    } catch (err) {
      setError((err as Error).message)
    } finally {
      setBusy(false)
    }
  }

  const run = async (fn: () => Promise<ServiceInstanceDescriptor>): Promise<void> => {
    setBusy(true)
    setError(null)
    try {
      onChanged(await fn())
    } catch (err) {
      setError((err as Error).message)
    } finally {
      setBusy(false)
    }
  }

  const status = statusOf(instance.status.health)
  const running = status === 'running'
  const sample = usageForOwner(processes, usage, 'service', instance.key)
  const ports = instance.status.ports.length
    ? instance.status.ports
    : Object.entries(instance.configSchema.properties ?? {})
        .filter(([, prop]) => prop.format === 'port')
        .map(([key]) => Number(instance.values[key]))
        .filter(Boolean)
  const blocks = block ? [block] : []
  const envId = `env-${instance.key}`
  const instanceLogs = logs.filter((l) => l.source === instance.key)

  return (
    <div className="instance-panel">
      <div className={`instance-panel-head ${pinHeader ? 'pinned' : ''}`}>
        <ServiceIcon
          id={instance.serviceId}
          displayName={instance.displayName}
          icon={instance.icon}
          tint={instance.tint}
          catalogue={catalogueNames}
          size={32}
        />
        <div style={{ minWidth: 0 }}>
          <div className="hstack" style={{ gap: 9 }}>
            <span style={{ fontSize: 15, fontWeight: 600 }}>{instance.displayName}</span>
            <span className="mono small muted">{instance.version}</span>
          </div>
          <div className="hstack" style={{ gap: 8, marginTop: 3 }}>
            <span className="hstack" style={{ gap: 6, fontSize: 12, color: 'var(--tx2)' }}>
              <StatusDot status={busy ? 'busy' : status} />
              {busy
                ? running
                  ? 'Stopping…'
                  : 'Starting…'
                : running
                  ? 'Healthy'
                  : instance.installed
                    ? 'Stopped'
                    : 'Not installed'}
            </span>
            <span className="mono small" style={{ color: running ? 'var(--gn)' : 'var(--tx3)' }}>
              {instance.status.detail ?? instance.status.error ?? 'no health data'}
            </span>
          </div>
        </div>

        <div className="grow" />

        {ports.map((port) => (
          <span key={port} className="pill mono" style={{ height: 26, padding: '0 9px' }}>
            :{port}
          </span>
        ))}
        {/* Only when there is a reading. Two bare dashes beside the port pill
            label nothing and read as broken rather than as "not running". */}
        {sample && (
          <span className="mono small muted">
            {sample.cpu.toFixed(1)}% · {formatBytes(sample.memory)}
          </span>
        )}
        {/* Only while running: the console is served by the service itself, so
            the link is dead when it is stopped. */}
        {instance.console && running && (
          <ExternalLink className="btn" href={instance.console.url}>
            {instance.console.label} ↗
          </ExternalLink>
        )}
        <button
          type="button"
          className={`btn ${running ? '' : 'primary'}`}
          disabled={busy}
          onClick={() => void run(() => invoke(running ? 'services:stop' : 'services:start', ref))}
        >
          {running ? 'Stop' : 'Start'}
        </button>
        {onDetach && (
          <button type="button" className="btn danger" disabled={busy} onClick={onDetach}>
            Remove
          </button>
        )}
      </div>

      {error && <p className="error-text">{error}</p>}

      <div className="instance-panel-body">
        <SchemaForm
          schema={instance.configSchema}
          values={instance.values}
          errors={fieldErrors}
          busy={busy}
          onSave={(values) => void saveConfig(values)}
          onReset={() => void saveConfig({})}
        />

        <div className="card">
          <div className="card-head tinted" style={{ padding: '9px 14px' }}>
            <span className="mono small" style={{ color: 'var(--tx2)' }}>
              {instance.serviceId}.env
            </span>
            <span className="small muted">
              live values for {ownerLabel} · {instance.envKeys.length} variables
            </span>
            <div className="grow" />
            <button
              type="button"
              className={`btn xs ${copied === envId ? 'ok' : 'primary'}`}
              style={{ height: 24 }}
              onClick={() => copy(toText(blocks), envId)}
            >
              {copied === envId ? '✓ Copied' : '⧉ Copy'}
            </button>
          </div>
          <EnvLines rows={toRows(blocks, false)} gutter={false} />
        </div>

        <div className="card">
          <div className="card-head tinted" style={{ padding: '9px 14px' }}>
            <button type="button" className="link-btn" onClick={() => setShowLogs((v) => !v)}>
              {showLogs ? '▾' : '▸'} Logs
            </button>
            <span className="small muted">{instanceLogs.length} lines buffered</span>
            <div className="grow" />
            {onOpenLogs && (
              <button
                type="button"
                className="back"
                style={{ color: 'var(--ac)' }}
                onClick={onOpenLogs}
              >
                Open in unified logs →
              </button>
            )}
          </div>
          {showLogs && (
            <div className="log-pane" style={{ maxHeight: 260 }}>
              <LogRows lines={instanceLogs.slice(-300)} compact />
            </div>
          )}
        </div>
      </div>
    </div>
  )
}

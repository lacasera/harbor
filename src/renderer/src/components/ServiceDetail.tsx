import { useEffect, useMemo, useState } from 'react'
import type {
  EnvBlock as EnvBlockData,
  FieldError,
  ServiceDescriptor
} from '../../../shared/service.js'
import type { LogLine } from '../../../shared/logs.js'
import type { ProcessHandle, ResourceUsage } from '../../../shared/process.js'
import type { ServiceTab } from '../routes.js'
import { invoke } from '../ipc/client.js'
import {
  StatusDot,
  Tabs,
  formatBytes,
  monogramsFor,
  statusOf,
  tintFor,
  useCopy,
  usageForOwner
} from './primitives.js'
import { EnvLines, toRows, toText } from './EnvBlock.js'
import { SchemaForm } from './SchemaForm.js'
import { LogRows } from './LogsView.js'

export function ServiceDetail({
  service,
  catalogue,
  processes,
  usage,
  logs,
  onBack,
  onChanged,
  onOpenLogs
}: {
  service: ServiceDescriptor
  /** The whole catalogue, so this tile's monogram matches the grid's. */
  catalogue: ServiceDescriptor[]
  processes: ProcessHandle[]
  usage: ResourceUsage[]
  logs: LogLine[]
  onBack: () => void
  onChanged: (next: ServiceDescriptor) => void
  onOpenLogs: () => void
}): React.JSX.Element {
  const [tab, setTab] = useState<ServiceTab>('config')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [block, setBlock] = useState<EnvBlockData | null>(null)
  const [fieldErrors, setFieldErrors] = useState<FieldError[]>([])
  const { copied, copy } = useCopy()
  const monograms = useMemo(
    () => monogramsFor(catalogue.map((s) => s.displayName)),
    [catalogue]
  )

  useEffect(() => {
    let cancelled = false
    void invoke('services:envBlock', service.id).then((result) => {
      if (!cancelled) setBlock(result)
    })
    return () => {
      cancelled = true
    }
  }, [service.id, service.status.health, service.config])

  /** Validation failure is an expected result here, not an exception. */
  const saveConfig = async (values: Record<string, unknown>): Promise<void> => {
    setBusy(true)
    setError(null)
    try {
      const result = await invoke('services:updateConfig', service.id, { values })
      if (result.ok) {
        setFieldErrors([])
        onChanged(result.service)
      } else {
        setFieldErrors(result.errors)
      }
    } catch (err) {
      setError((err as Error).message)
    } finally {
      setBusy(false)
    }
  }

  const run = async (fn: () => Promise<ServiceDescriptor>): Promise<void> => {
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

  const status = statusOf(service.status.health)
  const running = status === 'running'
  const sample = usageForOwner(processes, usage, 'service', service.id)
  const ports = service.status.ports.length ? service.status.ports : service.defaultPorts
  const blocks = block ? [block] : []

  return (
    <>
      <div className="detail-head">
        <button type="button" className="back" onClick={onBack}>
          ‹ Services
        </button>

        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            gap: 20,
            marginTop: 8
          }}
        >
          <div className="hstack" style={{ gap: 12, flexWrap: 'nowrap' }}>
            <div className="svc-mono lg" style={{ background: tintFor(service.id) }}>
              {monograms.get(service.displayName)}
            </div>
            <div>
              <div className="hstack" style={{ gap: 9 }}>
                <span className="page-title">{service.displayName}</span>
                <span className="mono small muted">{service.config.version}</span>
              </div>
              <div className="hstack" style={{ gap: 10, marginTop: 4 }}>
                <span className="hstack" style={{ gap: 6, fontSize: 12, color: 'var(--tx2)' }}>
                  <StatusDot status={status} />
                  {running ? 'Healthy' : service.installed ? 'Stopped' : 'Not installed'}
                </span>
                <span
                  className="mono small"
                  style={{ color: running ? 'var(--gn)' : 'var(--tx3)' }}
                >
                  {service.status.detail ?? service.status.error ?? 'no health data'}
                </span>
              </div>
            </div>
          </div>

          <div className="hstack">
            {ports.map((port) => (
              <span
                key={port}
                className="pill mono"
                style={{ height: 26, padding: '0 9px', fontSize: 11.5 }}
              >
                :{port}
              </span>
            ))}
            {!service.installed ? (
              <button
                type="button"
                className="btn primary"
                disabled={busy}
                onClick={() => void run(() => invoke('services:install', service.id, 'latest').then(() => invoke('services:start', service.id)))}
              >
                Install &amp; start
              </button>
            ) : (
              <button
                type="button"
                className={`btn ${running ? '' : 'primary'}`}
                disabled={busy}
                onClick={() =>
                  void run(() =>
                    running
                      ? invoke('services:stop', service.id)
                      : invoke('services:start', service.id)
                  )
                }
              >
                {running ? 'Stop service' : 'Start service'}
              </button>
            )}
          </div>
        </div>

        <Tabs
          active={tab}
          onSelect={setTab}
          tabs={[
            { id: 'config', label: 'Config' },
            { id: 'env', label: 'Env' },
            { id: 'logs', label: 'Logs' }
          ]}
        />
      </div>

      <div className={`page-body ${tab === 'logs' ? 'fill' : ''}`} style={{ paddingTop: 20 }}>
        {error && <p className="error-text">{error}</p>}

        {tab === 'config' && (
          <div className="two-col wide-left">
            <SchemaForm
              schema={service.configSchema}
              values={service.config.values}
              errors={fieldErrors}
              busy={busy}
              onSave={(values) => void saveConfig(values)}
              onReset={() => void saveConfig({})}
            />

            <div className="stack">
              <div className="card card-pad">
                <div style={{ fontSize: 12.5, fontWeight: 600, marginBottom: 6 }}>Runtime</div>
                {[
                  ['CPU', sample ? `${sample.cpu.toFixed(1)}%` : '—'],
                  ['Memory', sample ? formatBytes(sample.memory) : '—'],
                  ['Backend', service.backend],
                  ['Version', service.config.version]
                ].map(([k, v]) => (
                  <div key={k} className="stat-row">
                    <span className="k">{k}</span>
                    <span className="v">{v}</span>
                  </div>
                ))}
              </div>

              <div className="card">
                <div className="card-head tinted" style={{ padding: '10px 12px' }}>
                  <span className="mono small" style={{ color: 'var(--tx2)' }}>
                    .env
                  </span>
                  <button
                    type="button"
                    className={`btn xs ${copied === 'svcenv' ? 'ok' : 'primary'}`}
                    style={{ height: 24 }}
                    onClick={() => copy(toText(blocks), 'svcenv')}
                  >
                    {copied === 'svcenv' ? '✓ Copied' : '⧉ Copy'}
                  </button>
                </div>
                <EnvLines rows={toRows(blocks, false)} gutter={false} />
              </div>
            </div>
          </div>
        )}

        {tab === 'env' && (
          <div>
            <div
              style={{
                display: 'flex',
                alignItems: 'flex-end',
                justifyContent: 'space-between',
                gap: 16,
                marginBottom: 12
              }}
            >
              <div>
                <div style={{ fontSize: 14, fontWeight: 600 }}>Environment variables</div>
                <div
                  style={{
                    marginTop: 3,
                    fontSize: 12.5,
                    color: 'var(--tx2)',
                    maxWidth: 520,
                    lineHeight: 1.5,
                    textWrap: 'pretty'
                  }}
                >
                  Values below are read from the running instance — bound ports and resolved
                  credentials, not templates.
                </div>
              </div>
              <button
                type="button"
                className={`btn ${copied === 'svcenv' ? 'ok' : 'primary'}`}
                onClick={() => copy(toText(blocks), 'svcenv')}
              >
                {copied === 'svcenv' ? '✓ Copied' : '⧉ Copy'}
              </button>
            </div>

            <div className="card">
              <div className="card-head tinted" style={{ padding: '9px 14px' }}>
                <span className="mono small" style={{ color: 'var(--tx2)' }}>
                  {service.id}.env
                </span>
                <span className="small muted">{service.envKeys.length} variables</span>
                <div className="grow" />
                <span className="live">
                  <span className="dot sm running" />
                  live values
                </span>
              </div>
              <EnvLines rows={toRows(blocks, false)} />
            </div>
          </div>
        )}

        {tab === 'logs' && (
          <div className="card">
            <div className="card-head tinted">
              <span>{service.displayName}</span>
              <span className="mono small muted">stdout + stderr</span>
              <div className="grow" />
              <button
                type="button"
                className="back"
                style={{ color: 'var(--ac)' }}
                onClick={onOpenLogs}
              >
                Open in unified logs →
              </button>
            </div>
            <div className="log-pane">
              <LogRows lines={logs.filter((l) => l.source === service.id).slice(-500)} compact />
            </div>
          </div>
        )}
      </div>
    </>
  )
}

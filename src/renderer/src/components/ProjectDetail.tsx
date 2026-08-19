import { useCallback, useEffect, useMemo, useState } from 'react'
import type { ProjectDescriptor } from '../../../shared/project.js'
import type { AnalysisResult } from '../../../shared/intelligence.js'
import type { EnvBlock as EnvBlockData, ServiceDescriptor } from '../../../shared/service.js'
import type { RuntimeDescriptor } from '../../../shared/runtime.js'
import type { LogLine } from '../../../shared/logs.js'
import type { ProcessHandle, ResourceUsage } from '../../../shared/process.js'
import type { ProjectTab } from '../routes.js'
import { invoke, subscribe } from '../ipc/client.js'
import {
  CopyIconButton,
  StatusDot,
  Tabs,
  Toggle,
  formatBytes,
  formatUptime,
  processForOwner,
  statusOf,
  tintFor,
  useCopy,
  usageForOwner
} from './primitives.js'
import { EnvLines, toRows, toText } from './EnvBlock.js'
import { Insights } from './Insights.js'
import { LogRows } from './LogsView.js'

export function ProjectDetail({
  project,
  services,
  runtimes,
  processes,
  usage,
  logs,
  onBack,
  onChanged,
  onOpenServices,
  onOpenLogs
}: {
  project: ProjectDescriptor
  services: ServiceDescriptor[]
  runtimes: RuntimeDescriptor[]
  processes: ProcessHandle[]
  usage: ResourceUsage[]
  logs: LogLine[]
  onBack: () => void
  onChanged: (next: ProjectDescriptor) => void
  onOpenServices: () => void
  onOpenLogs: () => void
}): React.JSX.Element {
  const [tab, setTab] = useState<ProjectTab>('overview')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const { copied, copy } = useCopy()

  const run = async (fn: () => Promise<ProjectDescriptor>): Promise<void> => {
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

  const proc = processForOwner(processes, 'project', project.id)
  const sample = usageForOwner(processes, usage, 'project', project.id)

  return (
    <>
      <div className="detail-head">
        <button type="button" className="back" onClick={onBack}>
          ‹ Projects
        </button>

        <div
          style={{
            display: 'flex',
            alignItems: 'flex-start',
            justifyContent: 'space-between',
            gap: 20,
            marginTop: 8
          }}
        >
          <div>
            <div className="hstack" style={{ gap: 9 }}>
              <StatusDot status={project.running ? 'running' : 'stopped'} />
              <span className="page-title">{project.name}</span>
              <span className="pill">
                <span className="square" style={{ background: tintFor(project.typeId) }} />
                {project.typeId}
              </span>
              {project.frameworkId && <span className="pill mono">{project.frameworkId}</span>}
            </div>
            <div className="hstack" style={{ gap: 6, marginTop: 6, paddingLeft: 17 }}>
              <a className="mono" style={{ fontSize: 12.5 }} href={project.url} target="_blank" rel="noreferrer">
                {project.url}
              </a>
              <CopyIconButton
                text={project.url}
                copyKey="pd"
                copied={copied}
                copy={copy}
                title="Copy domain"
              />
              <span className="mono small muted" style={{ marginLeft: 6 }}>
                {project.path}
              </span>
            </div>
          </div>

          <div className="hstack">
            {project.serveModel === 'reverse-proxy' && (
              <button
                type="button"
                className={`btn ${project.running ? '' : 'primary'}`}
                disabled={busy}
                onClick={() =>
                  void run(() =>
                    project.running
                      ? invoke('projects:stop', project.id)
                      : invoke('projects:start', project.id)
                  )
                }
              >
                {project.running ? 'Stop' : 'Start'}
              </button>
            )}
          </div>
        </div>

        <Tabs
          active={tab}
          onSelect={setTab}
          tabs={[
            { id: 'overview', label: 'Overview' },
            { id: 'env', label: 'Env' },
            { id: 'insights', label: 'Insights' },
            { id: 'logs', label: 'Logs' }
          ]}
        />
      </div>

      <div className="page-body" style={{ paddingTop: 20 }}>
        {error && <p className="error-text">{error}</p>}

        {tab === 'overview' && (
          <Overview
            project={project}
            runtimes={runtimes}
            services={services}
            proc={proc}
            sample={sample}
            busy={busy}
            copied={copied}
            copy={copy}
            onPatch={(patch) => void run(() => invoke('projects:update', project.id, patch))}
            onOpenServices={onOpenServices}
          />
        )}

        {tab === 'env' && (
          <EnvTab
            project={project}
            services={services}
            onManage={() => setTab('overview')}
          />
        )}

        {tab === 'insights' && <InsightsTab project={project} />}

        {tab === 'logs' && (
          <div className="card" style={{ maxWidth: 1180 }}>
            <div className="card-head tinted">
              <span>{project.name}</span>
              <span className="mono small muted">{proc ? `pid ${proc.pid ?? '—'}` : 'no process'}</span>
              <div className="grow" />
              <button type="button" className="back" style={{ color: 'var(--ac)' }} onClick={onOpenLogs}>
                Open in unified logs →
              </button>
            </div>
            <div className="log-pane">
              <LogRows lines={logs.filter((l) => l.source === project.id).slice(-60)} compact />
            </div>
          </div>
        )}
      </div>
    </>
  )
}

function Overview({
  project,
  runtimes,
  services,
  proc,
  sample,
  busy,
  copied,
  copy,
  onPatch,
  onOpenServices
}: {
  project: ProjectDescriptor
  runtimes: RuntimeDescriptor[]
  services: ServiceDescriptor[]
  proc: ProcessHandle | undefined
  sample: ResourceUsage | undefined
  busy: boolean
  copied: string | null
  copy: (text: string, key: string) => void
  onPatch: (patch: {
    runtimeOverride?: { runtime: string; version: string } | null
    secure?: boolean
    serviceIds?: string[]
  }) => void
  onOpenServices: () => void
}): React.JSX.Element {
  const resolved = project.resolvedRuntime
  const runtime = runtimes.find((r) => r.id === resolved?.runtime)
  const versions = runtime?.installedVersions ?? []

  const stats: Array<[string, string]> =
    project.serveModel === 'reverse-proxy'
      ? [
          ['PID', proc?.pid ? String(proc.pid) : '—'],
          ['CPU', sample ? `${sample.cpu.toFixed(1)}%` : '—'],
          ['Memory', sample ? formatBytes(sample.memory) : '—'],
          ['Uptime', formatUptime(proc?.startedAt ?? null)]
        ]
      : [
          ['Serve model', project.serveModel],
          ['Front door', 'nginx'],
          ['Port', project.port ? String(project.port) : '—'],
          ['Restarts', proc ? String(proc.restarts) : '—']
        ]

  return (
    <div className="two-col">
      <div className="card">
        <div className="card-head">Configuration</div>

        <div className="row">
          <div className="k">Domain</div>
          <div className="v">
            <span className="mono" style={{ fontSize: 12.5 }}>
              {project.domain}
            </span>
            <span className="small muted">resolved by Harbor DNS</span>
          </div>
        </div>

        <div className="row">
          <div className="k">Path</div>
          <div className="v">
            <span className="mono small" style={{ color: 'var(--tx2)', fontSize: 12.5 }}>
              {project.path}
            </span>
            <CopyIconButton
              text={project.path}
              copyKey="pp"
              copied={copied}
              copy={copy}
              title="Copy path"
            />
          </div>
        </div>

        <div className="row">
          <div className="k">Detected type</div>
          <div className="v" style={{ fontSize: 12.5 }}>
            {project.typeId}
            <span className="small muted">
              — {project.typeOverridden ? 'set manually' : 'auto-detected on park'}
              {project.frameworkId && `, ${project.frameworkId} driver`}
            </span>
          </div>
        </div>

        <div className="row">
          <div>
            <div className="k">Runtime version</div>
            <div className="hint">Overrides the resolved default</div>
          </div>
          <div className="v">
            <select
              className="field-select"
              style={{ minWidth: 168 }}
              disabled={busy || !runtime || !versions.length}
              value={resolved?.version ?? ''}
              onChange={(e) =>
                resolved &&
                onPatch({ runtimeOverride: { runtime: resolved.runtime, version: e.target.value } })
              }
            >
              {!versions.length && <option value="">none installed</option>}
              {versions.map((v) => (
                <option key={v} value={v}>
                  {runtime?.displayName} {v}
                </option>
              ))}
            </select>
            <span className="small muted">{resolved ? `via ${resolved.detail}` : 'no runtime'}</span>
          </div>
        </div>

        <div className="row">
          <div className="k">Start command</div>
          <div className="v">
            <div
              className="field-input mono"
              style={{ flex: 1, maxWidth: 340, display: 'flex', alignItems: 'center' }}
            >
              {project.resolvedStartCommand ?? '—'}
            </div>
            <span className="small muted">
              {project.serveModel === 'fpm'
                ? 'served by PHP-FPM'
                : project.serveModel === 'static'
                  ? 'served from disk'
                  : `proxied to :${project.port ?? '—'}`}
            </span>
          </div>
        </div>

        <div className="row">
          <div>
            <div className="k">Secure (TLS)</div>
            <div className="hint">Trusted local certificate</div>
          </div>
          <div className="v">
            <Toggle
              on={project.secure}
              label="Secure with TLS"
              disabled={busy}
              onChange={(secure) => onPatch({ secure })}
            />
            <span className="mono small muted">
              {project.secure ? 'mkcert certificate' : 'served over http://'}
            </span>
          </div>
        </div>
      </div>

      <div className="stack">
        <div className="card">
          <div className="card-head">
            <span>Process</span>
            <span className="hstack" style={{ gap: 6, fontSize: 11.5, color: 'var(--tx2)' }}>
              <StatusDot status={project.running ? 'running' : 'stopped'} small />
              {project.running ? 'Running' : 'Idle'}
            </span>
          </div>
          <div style={{ padding: '4px 14px 12px' }}>
            {stats.map(([k, v]) => (
              <div key={k} className="stat-row">
                <span className="k">{k}</span>
                <span className="v">{v}</span>
              </div>
            ))}
          </div>
        </div>

        <div className="card card-pad">
          <div style={{ fontSize: 12.5, fontWeight: 600, marginBottom: 4 }}>Services</div>
          <div className="hint" style={{ marginBottom: 10 }}>
            Chosen here, exported on the Env tab
          </div>
          <div className="hstack" style={{ gap: 6 }}>
            {services.map((service) => {
              const on = project.serviceIds.includes(service.id)
              return (
                <button
                  key={service.id}
                  type="button"
                  className={`chip ${on ? 'on' : ''}`}
                  disabled={busy}
                  onClick={() =>
                    onPatch({
                      serviceIds: on
                        ? project.serviceIds.filter((id) => id !== service.id)
                        : [...project.serviceIds, service.id]
                    })
                  }
                >
                  <StatusDot status={statusOf(service.status.health)} small />
                  {service.displayName}
                </button>
              )
            })}
          </div>
          <button
            type="button"
            className="back"
            style={{ marginTop: 12, color: 'var(--ac)' }}
            onClick={onOpenServices}
          >
            Manage services →
          </button>
        </div>
      </div>
    </div>
  )
}

function EnvTab({
  project,
  services,
  onManage
}: {
  project: ProjectDescriptor
  services: ServiceDescriptor[]
  onManage: () => void
}): React.JSX.Element {
  const [blocks, setBlocks] = useState<EnvBlockData[]>([])
  const { copied, copy } = useCopy()

  // Only this project's services — an aggregate of everything running was a
  // stand-in until projects could declare what they use.
  const selected = useMemo(
    () => project.serviceIds.filter((id) => services.some((s) => s.id === id)),
    [project.serviceIds, services]
  )

  useEffect(() => {
    let cancelled = false
    void invoke('services:envBlocks', selected).then((result) => {
      if (!cancelled) setBlocks(result)
    })
    return () => {
      cancelled = true
    }
  }, [selected])

  const rows = toRows(blocks, true)
  const varCount = rows.filter((r) => r.eq).length
  const done = copied === 'allenv'

  return (
    <div style={{ maxWidth: 860 }}>
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
          <div style={{ fontSize: 14, fontWeight: 600 }}>Aggregated environment</div>
          <div
            style={{
              marginTop: 3,
              fontSize: 12.5,
              color: 'var(--tx2)',
              maxWidth: 560,
              lineHeight: 1.5,
              textWrap: 'pretty'
            }}
          >
            Merged from every running service, deduped, with live values from the running
            instances — real ports, real credentials.
          </div>
        </div>
        <button
          type="button"
          className={`btn ${done ? 'ok' : 'primary'}`}
          onClick={() => copy(toText(blocks), 'allenv')}
        >
          {done ? '✓ Copied' : '⧉ Copy all .env'}
        </button>
      </div>

      <div className="card">
        <div className="card-head tinted" style={{ padding: '9px 14px' }}>
          <span className="mono small" style={{ color: 'var(--tx2)' }}>
            .env
          </span>
          <span className="divider-v" />
          <span className="small muted">
            {varCount} variables · {blocks.length} services
          </span>
          <div className="grow" />
          <span className="live">
            <span className="dot sm running" />
            live values
          </span>
        </div>
        <EnvLines rows={rows} />
      </div>

      {!selected.length && (
        <p className="small muted" style={{ marginTop: 12 }}>
          No services selected for this project yet —{' '}
          <button type="button" className="back" style={{ color: 'var(--ac)' }} onClick={onManage}>
            choose them on the Overview tab
          </button>
          .
        </p>
      )}

      <div className="hstack" style={{ marginTop: 12 }}>
        <button
          type="button"
          className="btn sm"
          onClick={() =>
            copy(rows.filter((r) => r.eq).map((r) => `export ${r.key}=${r.value}`).join('\n'), 'sh')
          }
        >
          {copied === 'sh' ? 'Copied' : 'Copy as shell exports'}
        </button>
        <button
          type="button"
          className="btn sm"
          onClick={() =>
            copy(
              JSON.stringify(
                Object.fromEntries(rows.filter((r) => r.eq).map((r) => [r.key, r.value])),
                null,
                2
              ),
              'json'
            )
          }
        >
          {copied === 'json' ? 'Copied' : 'Copy as JSON'}
        </button>
      </div>
    </div>
  )
}

function InsightsTab({ project }: { project: ProjectDescriptor }): React.JSX.Element {
  const [results, setResults] = useState<AnalysisResult[]>([])
  const [analyzing, setAnalyzing] = useState(true)

  const analyze = useCallback(
    (force: boolean) => {
      setAnalyzing(true)
      void invoke('intelligence:analyze', project.id, force)
        .then(setResults)
        .catch(() => setResults([]))
        .finally(() => setAnalyzing(false))
    },
    [project.id]
  )

  useEffect(() => analyze(false), [analyze])

  // Re-analyze on a source change so an open diagram cannot go stale.
  useEffect(
    () =>
      subscribe('analysis:invalidated', (id) => {
        if (id === project.id) analyze(true)
      }),
    [project.id, analyze]
  )

  return <Insights results={results} analyzing={analyzing} onAnalyze={() => analyze(true)} />
}

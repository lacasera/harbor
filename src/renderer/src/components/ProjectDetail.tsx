import { useCallback, useEffect, useMemo, useState } from 'react'
import type {
  ProjectDescriptor,
  ProjectEnvFile,
  ProjectProcessDescriptor
} from '../../../shared/project.js'
import type { AnalysisResult } from '../../../shared/intelligence.js'
import type {
  EnvBlock as EnvBlockData,
  ServiceDescriptor,
  ServiceInstanceDescriptor
} from '../../../shared/service.js'
import type { RuntimeDescriptor } from '../../../shared/runtime.js'
import type { LogLine } from '../../../shared/logs.js'
import type { ProcessHandle, ResourceUsage } from '../../../shared/process.js'
import type { ProjectTab } from '../routes.js'
import { invoke, subscribe } from '../ipc/client.js'
import { TypeIcon, typeLabel } from './TypeIcon.js'
import {
  CopyIconButton,
  StatusDot,
  Tabs,
  Toggle,
  formatBytes,
  formatUptime,
  processForOwner,
  statusOf,
  useCopy,
  usageForOwner
} from './primitives.js'
import { EnvLines, toRows, toText } from './EnvBlock.js'
import { Insights } from './Insights.js'
import { LogRows } from './LogsView.js'
import { ExternalLink } from './ExternalLink.js'
import { ServiceIcon } from './ServiceIcon.js'
import { ServiceInstancePanel } from './ServiceInstancePanel.js'

/** Kept beside the UI that offers them; the main process is the authority. */
const PROJECT_TYPES = [
  { id: 'php', label: 'PHP' },
  { id: 'node-server', label: 'Node server' },
  { id: 'static', label: 'Static site' }
]

export function ProjectDetail({
  project,
  services,
  runtimes,
  processes,
  usage,
  logs,
  onBack,
  onChanged,
  onInstanceChanged,
  onCatalogueChanged,
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
  onInstanceChanged: (next: ServiceInstanceDescriptor) => void
  onCatalogueChanged: (next: ServiceDescriptor[]) => void
  onOpenServices: () => void
  onOpenLogs: () => void
}): React.JSX.Element {
  // Derived from the catalogue, which is the only place instances live. The
  // project used to carry its own copy and it went stale the moment anything
  // changed one — a start, a stop, or the background health poll.
  const instances = useMemo(
    () => services.flatMap((s) => s.instances).filter((i) => i.owner === project.id),
    [services, project.id]
  )
  const [tab, setTab] = useState<ProjectTab>('overview')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [confirmForget, setConfirmForget] = useState(false)
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
              <StatusDot status={project.served ? 'running' : 'stopped'} />
              <span className="page-title">{project.name}</span>
              <span className="pill">
                <TypeIcon frameworkId={project.frameworkId} typeId={project.typeId} size={13} />
                {typeLabel(project.frameworkId, project.typeId)}
              </span>
              <span className="pill mono">{project.serveModel}</span>
            </div>
            <div className="hstack" style={{ gap: 6, marginTop: 6, paddingLeft: 17 }}>
              <ExternalLink className="mono" style={{ fontSize: 12.5 }} href={project.url}>
                {project.url}
              </ExternalLink>
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
            {confirmForget ? (
              <>
                <button
                  type="button"
                  className="btn danger"
                  disabled={busy}
                  onClick={() => {
                    setBusy(true)
                    void invoke('projects:forget', project.id)
                      .then(onBack)
                      .catch((err: Error) => setError(err.message))
                      .finally(() => setBusy(false))
                  }}
                >
                  Remove {project.name}
                </button>
                <button type="button" className="btn" onClick={() => setConfirmForget(false)}>
                  Cancel
                </button>
              </>
            ) : (
              <button type="button" className="btn" onClick={() => setConfirmForget(true)}>
                Forget project
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
            { id: 'logs', label: 'Logs' },
            { id: 'processes', label: 'Processes' },
            { id: 'services', label: 'Services' }
          ]}
        />
      </div>

      <div className={`page-body ${tab === 'logs' ? 'fill' : ''}`} style={{ paddingTop: 20 }}>
        {error && <p className="error-text">{error}</p>}

        {tab === 'overview' && (
          <Overview
            project={project}
            instances={instances}
            runtimes={runtimes}
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
          <EnvTab project={project} instances={instances} onManage={() => setTab('services')} />
        )}

        {tab === 'insights' && <InsightsTab project={project} />}

        {tab === 'processes' && (
          <ProcessesTab project={project} busy={busy} onChanged={onChanged} />
        )}

        {tab === 'services' && (
          <ServicesTab
            project={project}
            instances={instances}
            catalogue={services}
            processes={processes}
            usage={usage}
            logs={logs}
            onCatalogueChanged={onCatalogueChanged}
            onInstanceChanged={onInstanceChanged}
            onOpenLogs={onOpenLogs}
          />
        )}

        {tab === 'logs' && (
          <div className="card">
            <div className="card-head tinted">
              <span>{project.name}</span>
              <span className="mono small muted">
                {proc
                  ? `pid ${proc.pid ?? '—'}`
                  : project.serveModel === 'reverse-proxy'
                    ? 'no process'
                    : 'nginx + application logs'}
              </span>
              <div className="grow" />
              <button type="button" className="back" style={{ color: 'var(--ac)' }} onClick={onOpenLogs}>
                Open in unified logs →
              </button>
            </div>
            <div className="log-pane">
              {/* Not compact: these come from several files, so the stream
                  each line came from is the useful column. */}
              <LogRows lines={logs.filter((l) => l.source === project.id).slice(-500)} />
            </div>
          </div>
        )}
      </div>
    </>
  )
}

function Overview({
  project,
  instances,
  runtimes,
  proc,
  sample,
  busy,
  copied,
  copy,
  onPatch,
  onOpenServices
}: {
  project: ProjectDescriptor
  instances: ServiceInstanceDescriptor[]
  runtimes: RuntimeDescriptor[]
  proc: ProcessHandle | undefined
  sample: ResourceUsage | undefined
  busy: boolean
  copied: string | null
  copy: (text: string, key: string) => void
  onPatch: (patch: {
    typeId?: string
    redetectType?: boolean
    runtimeOverride?: { runtime: string; version: string } | null
    secure?: boolean
  }) => void
  onOpenServices: () => void
}): React.JSX.Element {
  const resolved = project.resolvedRuntime
  const runtime = runtimes.find((r) => r.id === resolved?.runtime)
  const versions = runtime?.installedVersions ?? []

  // An fpm or static site has no process of its own, so reporting PID/CPU for
  // it was reporting nothing. Show what actually serves it instead.
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
          ['Handler', project.servedBy ?? '—'],
          ['Runtime', project.resolvedRuntime ? `${project.resolvedRuntime.runtime} ${project.resolvedRuntime.version}` : '—']
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
          <div>
            <div className="k">Project type</div>
            <div className="hint">Decides how nginx serves it</div>
          </div>
          <div className="v">
            <select
              className="field-select"
              style={{ minWidth: 150 }}
              disabled={busy}
              value={project.typeId}
              onChange={(e) => onPatch({ typeId: e.target.value })}
            >
              {PROJECT_TYPES.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.label}
                </option>
              ))}
            </select>
            {project.typeOverridden ? (
              <button type="button" className="btn xs" disabled={busy} onClick={() => onPatch({ redetectType: true })}>
                Re-detect
              </button>
            ) : (
              <span className="small muted">
                auto-detected{project.frameworkId ? `, ${project.frameworkId} driver` : ''}
              </span>
            )}
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
            <span>{project.serveModel === 'reverse-proxy' ? 'Process' : 'Serving'}</span>
            <span className="hstack" style={{ gap: 6, fontSize: 11.5, color: 'var(--tx2)' }}>
              <StatusDot status={project.served ? 'running' : 'stopped'} small />
              {project.served ? 'Serving' : project.serveModel === 'reverse-proxy' ? 'Idle' : 'Not served'}
            </span>
          </div>
          <div style={{ padding: '4px 14px 12px' }}>
            {stats.map(([k, v]) => (
              <div key={k} className="stat-row">
                <span className="k">{k}</span>
                <span className="v">{v}</span>
              </div>
            ))}
            {project.servedProblem && (
              <p className="small" style={{ color: 'var(--am)', marginTop: 10 }}>
                {project.servedProblem}
              </p>
            )}
          </div>
        </div>

        <div className="card card-pad">
          <div style={{ fontSize: 12.5, fontWeight: 600, marginBottom: 4 }}>Services</div>
          <div className="hint" style={{ marginBottom: 10 }}>
            This project&rsquo;s own instances — its ports, its credentials, its data
          </div>
          <div className="hstack" style={{ gap: 6 }}>
            {instances.length ? (
              instances.map((instance) => (
                <span key={instance.key} className="chip on">
                  <StatusDot status={statusOf(instance.status.health)} small />
                  {instance.displayName}
                  <span className="mono small muted">
                    :{String(instance.status.ports[0] ?? instance.values.port ?? '—')}
                  </span>
                </span>
              ))
            ) : (
              <span className="small muted">None attached</span>
            )}
          </div>
          <button
            type="button"
            className="back"
            style={{ marginTop: 12, color: 'var(--ac)' }}
            onClick={onOpenServices}
          >
            Browse the catalogue →
          </button>
        </div>
      </div>
    </div>
  )
}

/**
 * Everything this project runs alongside being served.
 *
 * Detected entries come from the project's type and framework drivers, so the
 * list reflects what the application actually needs. Custom entries are the
 * escape hatch for everything a driver cannot know about — a bespoke worker, a
 * one-off artisan command, a tunnel.
 */
function ProcessesTab({
  project,
  busy,
  onChanged
}: {
  project: ProjectDescriptor
  busy: boolean
  onChanged: (next: ProjectDescriptor) => void
}): React.JSX.Element {
  const [working, setWorking] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [editing, setEditing] = useState<string | null>(null)
  const [draft, setDraft] = useState('')
  const [adding, setAdding] = useState(false)
  const [form, setForm] = useState({ label: '', command: '', runtime: '', autoStart: false })

  const act = (id: string, fn: () => Promise<ProjectDescriptor>): void => {
    setWorking(id)
    setError(null)
    void fn()
      .then(onChanged)
      .catch((err: Error) => setError(err.message))
      .finally(() => setWorking(null))
  }

  const detected = project.processes.filter((p) => !p.custom)
  const custom = project.processes.filter((p) => p.custom)

  const row = (p: ProjectProcessDescriptor): React.JSX.Element => (
    <div key={p.id} className="proc-item">
      <div className="proc-item-main">
        <div className="proc-head">
          <StatusDot
            status={p.running ? 'running' : p.state === 'crashed' ? 'error' : 'stopped'}
          />
          <span className="proc-label">{p.label}</span>
          {p.runtime && <span className="pill mono">{p.runtime}</span>}
          {p.overridden && <span className="pill mono">edited</span>}
          {p.state === 'crashed' && !p.running && (
            <span className="small" style={{ color: 'var(--rd)' }}>
              exited unexpectedly
            </span>
          )}
        </div>
        {p.description && <div className="hint">{p.description}</div>}

        {editing === p.id ? (
          <div className="hstack" style={{ gap: 6, marginTop: 8 }}>
            <input
              className="field-input mono"
              style={{ flex: 1 }}
              value={draft}
              autoFocus
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => e.key === 'Escape' && setEditing(null)}
            />
            <button
              type="button"
              className="btn xs"
              onClick={() => {
                setEditing(null)
                act(p.id, () =>
                  invoke('projects:updateProcess', project.id, p.id, { command: draft })
                )
              }}
            >
              Save
            </button>
            <button type="button" className="btn xs" onClick={() => setEditing(null)}>
              Cancel
            </button>
          </div>
        ) : (
          <button
            type="button"
            className="proc-command"
            title="Edit the command"
            onClick={() => {
              setEditing(p.id)
              setDraft(p.command)
            }}
          >
            {p.command}
          </button>
        )}
      </div>

      <div className="proc-item-actions">
        <label className="proc-auto" title="Start this automatically when Harbor launches">
          <Toggle
            on={p.enabled}
            label={`Start ${p.label} automatically when Harbor launches`}
            disabled={busy || working === p.id}
            onChange={(enabled) =>
              act(p.id, () => invoke('projects:updateProcess', project.id, p.id, { enabled }))
            }
          />
          <span className="small muted">auto</span>
        </label>

        <button
          type="button"
          className={`btn sm ${p.running ? '' : 'primary'}`}
          disabled={busy || working === p.id}
          onClick={() =>
            act(p.id, () =>
              invoke(
                p.running ? 'projects:stopProcess' : 'projects:startProcess',
                project.id,
                p.id
              )
            )
          }
        >
          {working === p.id ? '…' : p.running ? 'Stop' : 'Start'}
        </button>

        {p.custom && (
          <button
            type="button"
            className="btn xs danger"
            disabled={busy || working === p.id}
            onClick={() => act(p.id, () => invoke('projects:removeProcess', project.id, p.id))}
          >
            Remove
          </button>
        )}
      </div>
    </div>
  )

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      {error && <p className="error-text">{error}</p>}

      <div className="card">
        <div className="card-head">
          <span>Detected</span>
          <span className="small muted">
            From this project&apos;s {project.frameworkId ?? project.typeId} driver
          </span>
        </div>
        {detected.length ? (
          detected.map(row)
        ) : (
          <div className="proc-item">
            <span className="small muted">
              Nothing detected for this project type. Add a command below.
            </span>
          </div>
        )}
      </div>

      <div className="card">
        <div className="card-head">
          <span>Your commands</span>
          <button
            type="button"
            className="btn xs outline-ac"
            disabled={busy}
            onClick={() => setAdding((a) => !a)}
          >
            {adding ? 'Cancel' : 'Add command'}
          </button>
        </div>

        {adding && (
          <div className="proc-add">
            <div className="hstack" style={{ gap: 8 }}>
              <input
                className="field-input"
                style={{ width: 190 }}
                placeholder="Name, e.g. Reverb"
                value={form.label}
                autoFocus
                onChange={(e) => setForm({ ...form, label: e.target.value })}
              />
              <input
                className="field-input mono"
                style={{ flex: 1, minWidth: 240 }}
                placeholder="Command, e.g. php artisan reverb:start"
                value={form.command}
                onChange={(e) => setForm({ ...form, command: e.target.value })}
              />
              <select
                className="field-select"
                style={{ width: 110 }}
                value={form.runtime}
                onChange={(e) => setForm({ ...form, runtime: e.target.value })}
                title="Which runtime provides the binary"
              >
                <option value="">runtime…</option>
                <option value="php">php</option>
                <option value="node">node</option>
                <option value="bun">bun</option>
                <option value="deno">deno</option>
              </select>
            </div>
            <div className="hstack" style={{ gap: 10, marginTop: 10 }}>
              <label className="proc-auto">
                <Toggle
                  on={form.autoStart}
                  label="Start with the project"
                  onChange={(autoStart) => setForm({ ...form, autoStart })}
                />
                <span className="small muted">start with the project</span>
              </label>
              <div className="grow" />
              <button
                type="button"
                className="btn sm primary"
                disabled={busy || !form.label.trim() || !form.command.trim()}
                onClick={() =>
                  act('add', () =>
                    invoke('projects:addProcess', project.id, {
                      label: form.label,
                      command: form.command,
                      runtime: form.runtime || undefined,
                      autoStart: form.autoStart
                    }).then((next) => {
                      setForm({ label: '', command: '', runtime: '', autoStart: false })
                      setAdding(false)
                      return next
                    })
                  )
                }
              >
                Add
              </button>
            </div>
            <p className="hint" style={{ marginTop: 8 }}>
              Runs in the project directory. Anything long-running can start with the project;
              one-off commands are fine too — start them by hand and watch the Logs tab.
            </p>
          </div>
        )}

        {custom.length
          ? custom.map(row)
          : !adding && (
              <div className="proc-item">
                <span className="small muted">
                  Nothing yet. Anything the drivers cannot know about goes here.
                </span>
              </div>
            )}
      </div>
    </div>
  )
}

function EnvTab({
  project,
  instances,
  onManage
}: {
  project: ProjectDescriptor
  instances: ServiceInstanceDescriptor[]
  onManage: () => void
}): React.JSX.Element {
  const [blocks, setBlocks] = useState<EnvBlockData[]>([])
  const [envFile, setEnvFile] = useState<ProjectEnvFile | null>(null)
  const [revealed, setRevealed] = useState(false)
  const { copied, copy } = useCopy()

  useEffect(() => {
    let cancelled = false
    void invoke('projects:envFile', project.id).then((file) => {
      if (!cancelled) setEnvFile(file)
    })
    return () => {
      cancelled = true
    }
  }, [project.id])

  // Only this project's own instances. Each exports the port and credentials
  // it actually has, so two projects using "MySQL" get two different blocks.
  const refs = useMemo(
    () => instances.map((i) => ({ owner: i.owner, serviceId: i.serviceId })),
    [instances]
  )

  useEffect(() => {
    let cancelled = false
    void invoke('services:envBlocks', refs).then((result) => {
      if (!cancelled) setBlocks(result)
    })
    return () => {
      cancelled = true
    }
  }, [refs])

  const rows = toRows(blocks, true)
  const varCount = rows.filter((r) => r.eq).length
  const done = copied === 'allenv'

  // Which service keys would overwrite something the project already sets.
  const existing = new Map((envFile?.vars ?? []).map((v) => [v.key, v.value]))
  const conflicts = rows.filter((r) => r.eq && existing.has(r.key) && existing.get(r.key) !== r.value)

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>
      <div className="card">
        <div className="card-head tinted" style={{ padding: '9px 14px' }}>
          <span className="mono small" style={{ color: 'var(--tx2)' }}>
            {envFile?.path.split('/').pop() ?? '.env'}
          </span>
          <span className="divider-v" />
          <span className="small muted">
            {envFile?.exists
              ? `${envFile.vars.length} variables · the project's own file`
              : 'no .env in this project'}
          </span>
          <div className="grow" />
          {envFile?.vars.some((v) => v.secret) && (
            <button type="button" className="btn xs" onClick={() => setRevealed((r) => !r)}>
              {revealed ? 'Hide secrets' : 'Reveal secrets'}
            </button>
          )}
          <button
            type="button"
            className={`btn xs ${copied === 'projenv' ? 'ok' : ''}`}
            disabled={!envFile?.exists}
            onClick={() =>
              copy(
                (envFile?.vars ?? []).map((v) => `${v.key}=${v.value}`).join('\n'),
                'projenv'
              )
            }
          >
            {copied === 'projenv' ? '✓ Copied' : '⧉ Copy'}
          </button>
        </div>
        <EnvLines
          rows={(envFile?.vars ?? []).map((v, i) => ({
            id: v.key,
            n: String(i + 1),
            key: v.key,
            eq: '=',
            // Masked by default: this pane is as likely to be on a screen share
            // as anything else in the app.
            value: v.secret && !revealed ? '•'.repeat(Math.min(v.value.length, 24)) : v.value
          }))}
        />
        {envFile && !envFile.exists && (
          <p className="small muted" style={{ padding: '0 14px 12px' }}>
            Harbor reads this file, it never writes it.
          </p>
        )}
      </div>

      <div
        style={{
          display: 'flex',
          alignItems: 'flex-end',
          justifyContent: 'space-between',
          gap: 16,
          marginBottom: -8
        }}
      >
        <div>
          <div style={{ fontSize: 14, fontWeight: 600 }}>Service environment</div>
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
            Merged from this project's services, deduped, with live values from the running
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

      {conflicts.length > 0 && (
        <p className="small" style={{ color: 'var(--am)', marginTop: 10 }}>
          {conflicts.length} of these already differ in {envFile?.path.split('/').pop()}:{' '}
          <span className="mono">{conflicts.map((c) => c.key).join(', ')}</span> — pasting will
          change them.
        </p>
      )}

      {!refs.length && (
        <p className="small muted" style={{ marginTop: 12 }}>
          No services attached to this project yet —{' '}
          <button type="button" className="back" style={{ color: 'var(--ac)' }} onClick={onManage}>
            add one on the Services tab
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

/**
 * A project's own service stack.
 *
 * Master–detail rather than a list of expanding accordions. An instance's
 * configuration is a full page of form, and unfolding one inside the list
 * pushed every other service off the screen while the panel's own header
 * collided with the project header above it. A rail of services on the left and
 * one panel on the right keeps the whole stack visible while you configure any
 * part of it — and it matches how Projects and Services already work.
 */
function ServicesTab({
  project,
  instances,
  catalogue,
  processes,
  usage,
  logs,
  onCatalogueChanged,
  onInstanceChanged,
  onOpenLogs
}: {
  project: ProjectDescriptor
  instances: ServiceInstanceDescriptor[]
  catalogue: ServiceDescriptor[]
  processes: ProcessHandle[]
  usage: ResourceUsage[]
  logs: LogLine[]
  onCatalogueChanged: (next: ServiceDescriptor[]) => void
  onInstanceChanged: (next: ServiceInstanceDescriptor) => void
  onOpenLogs: () => void
}): React.JSX.Element {
  const [selected, setSelected] = useState<string | null>(null)
  const [adding, setAdding] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const names = useMemo(() => catalogue.map((s) => s.displayName), [catalogue])

  const attached = instances
  const available = catalogue.filter((s) => !attached.some((i) => i.serviceId === s.id))
  const active = attached.find((i) => i.key === selected) ?? attached[0] ?? null
  const running = attached.filter((i) => i.status.health === 'running').length

  const run = async (fn: () => Promise<ServiceDescriptor[]>): Promise<void> => {
    setBusy(true)
    setError(null)
    try {
      onCatalogueChanged(await fn())
    } catch (err) {
      setError((err as Error).message)
    } finally {
      setBusy(false)
    }
  }

  if (!attached.length) {
    return (
      <div className="card">
        <div className="empty" style={{ padding: 36 }}>
          <h3>No services yet</h3>
          <p>
            Add one and {project.name} gets its own instance of it — its own port, its own
            credentials, its own data. Nothing is shared with another project.
          </p>
          <div className="hstack" style={{ gap: 8, flexWrap: 'wrap', justifyContent: 'center' }}>
            {available.map((service) => (
              <AddServiceChip
                key={service.id}
                service={service}
                names={names}
                busy={busy}
                onAdd={() => void run(() => invoke('projects:attachService', project.id, service.id))}
              />
            ))}
          </div>
          {error && <p className="error-text">{error}</p>}
        </div>
      </div>
    )
  }

  return (
    <div className="stack-layout">
      <aside className="stack-rail">
        <div className="stack-rail-head">
          <span style={{ fontSize: 12.5, fontWeight: 600 }}>Stack</span>
          <span className="small muted">
            {running}/{attached.length} up
          </span>
        </div>

        {attached.map((instance) => {
          const port = instance.status.ports[0] ?? instance.values.port
          return (
            <button
              key={instance.key}
              type="button"
              className={`stack-rail-item ${active?.key === instance.key ? 'on' : ''}`}
              onClick={() => setSelected(instance.key)}
            >
              <ServiceIcon
                id={instance.serviceId}
                displayName={instance.displayName}
                icon={instance.icon}
                tint={instance.tint}
                catalogue={names}
                size={20}
              />
              <span className="stack-rail-name">{instance.displayName}</span>
              <StatusDot status={statusOf(instance.status.health)} small />
              <span className="mono small muted">{port ? `:${String(port)}` : ''}</span>
            </button>
          )
        })}

        <div className="stack-rail-actions">
          <button
            type="button"
            className="btn xs"
            disabled={busy}
            onClick={() => void run(() => invoke('projects:startStack', project.id))}
          >
            Start all
          </button>
          <button
            type="button"
            className="btn xs"
            disabled={busy}
            onClick={() => void run(() => invoke('projects:stopStack', project.id))}
          >
            Stop all
          </button>
        </div>

        <div className="stack-rail-add">
          <button
            type="button"
            className="link-btn"
            disabled={!available.length}
            onClick={() => setAdding((v) => !v)}
          >
            {adding ? '− Close' : '+ Add a service'}
          </button>
          {adding && (
            <div className="hstack" style={{ gap: 6, flexWrap: 'wrap', marginTop: 10 }}>
              {available.map((service) => (
                <AddServiceChip
                  key={service.id}
                  service={service}
                  names={names}
                  busy={busy}
                  onAdd={() => {
                    setAdding(false)
                    void run(() => invoke('projects:attachService', project.id, service.id))
                  }}
                />
              ))}
            </div>
          )}
          <div className="hint" style={{ marginTop: 10 }}>
            Each runs in <span className="mono">{project.composeProject}</span>. Databases cost
            roughly half a gigabyte of RAM each, so add what the project uses.
          </div>
        </div>
      </aside>

      <div style={{ minWidth: 0 }}>
        {error && <p className="error-text">{error}</p>}
        {active && (
          <ServiceInstancePanel
            key={active.key}
            instance={active}
            ownerLabel={project.name}
            catalogueNames={names}
            processes={processes}
            usage={usage}
            logs={logs}
            pinHeader
            onChanged={onInstanceChanged}
            onOpenLogs={onOpenLogs}
            onDetach={() =>
              void run(async () => {
                setSelected(null)
                return invoke('projects:detachService', project.id, active.serviceId)
              })
            }
          />
        )}
      </div>
    </div>
  )
}

function AddServiceChip({
  service,
  names,
  busy,
  onAdd
}: {
  service: ServiceDescriptor
  names: string[]
  busy: boolean
  onAdd: () => void
}): React.JSX.Element {
  return (
    <button type="button" className="chip" disabled={busy} onClick={onAdd}>
      <ServiceIcon
        id={service.id}
        displayName={service.displayName}
        icon={service.icon}
        tint={service.tint}
        catalogue={names}
        size={16}
      />
      {service.displayName}
    </button>
  )
}

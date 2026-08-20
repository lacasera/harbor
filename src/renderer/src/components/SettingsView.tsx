import { useCallback, useEffect, useState } from 'react'
import type {
  AppSettings,
  DnsStatus,
  NginxStatus,
  TlsStatus,
  UpdateStatus
} from '../../../shared/ipc.js'
import { invoke } from '../ipc/client.js'
import { StatusDot, Toggle } from './primitives.js'
import { adviseTld } from '../../../shared/tld.js'
import type { Diagnostic } from '../../../shared/diagnostics.js'
import type { ContainerRuntimeDescriptor } from '../../../shared/container-runtime.js'
import { AUTO_RUNTIME } from '../../../shared/container-runtime.js'

interface SystemStatus {
  nginx: NginxStatus
  tls: TlsStatus
  dns: DnsStatus
}

/** A system component's state plus the one action that advances it. */
function Step({
  label,
  hint,
  ok,
  detail,
  action,
  busy,
  onRun
}: {
  label: string
  hint: string
  ok: boolean
  detail: string
  action: string | null
  busy: boolean
  onRun: () => void
}): React.JSX.Element {
  return (
    <div className="row">
      <div>
        <div className="k">{label}</div>
        <div className="hint">{hint}</div>
      </div>
      <div className="v">
        <span className="hstack" style={{ gap: 6, fontSize: 12, color: 'var(--tx2)' }}>
          <span className={`dot sm ${ok ? 'running' : 'error'}`} />
          {detail}
        </span>
        {action && (
          <button
            type="button"
            className={`btn xs ${ok ? '' : 'outline-ac'}`}
            disabled={busy}
            onClick={onRun}
          >
            {busy ? 'Working…' : action}
          </button>
        )}
      </div>
    </div>
  )
}

export function SettingsView({ version, homeDir }: { version: string; homeDir: string }): React.JSX.Element {
  const [settings, setSettings] = useState<AppSettings | null>(null)
  const [status, setStatus] = useState<SystemStatus | null>(null)
  const [tld, setTld] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [update, setUpdate] = useState<UpdateStatus | null>(null)
  const [runtimes, setRuntimes] = useState<ContainerRuntimeDescriptor[]>([])
  const [runtimeBusy, setRuntimeBusy] = useState<string | null>(null)
  /** `auto`, or the id of a runtime the user picked deliberately. */
  const preference = settings?.containerRuntime ?? AUTO_RUNTIME
  /** The runtime currently in use, whether chosen automatically or pinned. */
  const active = runtimes.find((r) => r.selected) ?? null
  const [diagnostics, setDiagnostics] = useState<Diagnostic[]>([])
  const [checking, setChecking] = useState(false)

  /**
   * Everything Harbor depends on. Shown first because when it is wrong,
   * nothing below it works and the errors elsewhere describe symptoms.
   */
  const refreshDiagnostics = useCallback(async () => {
    setChecking(true)
    try {
      setDiagnostics(await invoke('app:diagnostics'))
    } finally {
      setChecking(false)
    }
  }, [])
  useEffect(() => {
    void refreshDiagnostics()
  }, [refreshDiagnostics])

  useEffect(() => {
    void invoke('containers:list').then(setRuntimes)
  }, [])

  const runRuntime = useCallback(
    async (key: string, fn: () => Promise<ContainerRuntimeDescriptor[]>) => {
      setRuntimeBusy(key)
      setError(null)
      try {
        setRuntimes(await fn())
        // The environment block reports the runtime too; leaving it stale would
        // have the same page disagreeing with itself.
        await refreshDiagnostics()
        setSettings(await invoke('settings:get'))
      } catch (err) {
        setError((err as Error).message)
      } finally {
        setRuntimeBusy(null)
      }
    },
    [refreshDiagnostics]
  )

  useEffect(() => {
    void invoke('settings:get').then((s) => {
      setSettings(s)
      setTld(s.tld)
    })
    void Promise.all([invoke('nginx:status'), invoke('tls:status'), invoke('dns:status')])
      .then(([nginx, tls, dns]) => setStatus({ nginx, tls, dns }))
      .catch((err: Error) => setError(err.message))
  }, [])

  /** Run a setup action and fold its returned status back into view state. */
  const act = (
    channel:
      | 'tls:install'
      | 'tls:installCa'
      | 'dns:install'
      | 'dns:start'
      | 'dns:stop'
      | 'dns:configureResolver'
      | 'dns:flush',
    apply: (next: TlsStatus | DnsStatus) => void
  ): void => {
    setBusy(true)
    setError(null)
    void invoke(channel)
      .then((next) => apply(next))
      .catch((e: Error) => setError(e.message))
      .finally(() => setBusy(false))
  }

  // "Running" is not the same as "serving": a master started on 8080 keeps
  // listening there no matter what the config now says.
  const advice = adviseTld(tld)

  // Defensive on the array: a single missing field should not blank the whole
  // window, and this pane is the one people open when something is already
  // wrong.
  const listening = status?.nginx.listening ?? []
  const boundCorrectly = Boolean(
    status?.nginx.running &&
      settings &&
      listening.includes(settings.httpPort) &&
      listening.includes(settings.httpsPort)
  )

  /**
   * Changing the TLD is only half the job: macOS needs a resolver file for the
   * new suffix or nothing resolves, which is exactly the state a user lands in
   * if the change quietly succeeds. Offer that step immediately, as one prompt
   * caused by one deliberate click.
   */
  const applyTld = async (): Promise<void> => {
    setBusy(true)
    setError(null)
    try {
      setSettings(await invoke('settings:update', { tld }))
      const dns = await invoke('dns:status')
      setStatus((s) => (s ? { ...s, dns } : s))
      if (!dns.resolverConfigured) {
        const next = await invoke('dns:configureResolver')
        setStatus((s) => (s ? { ...s, dns: next } : s))
      }
    } catch (err) {
      setError(
        `${(err as Error).message} — sites are re-homed, but *.${tld} will not resolve until ` +
          `the resolver below is written.`
      )
    } finally {
      setBusy(false)
    }
  }

  const patch = async (next: Partial<AppSettings>): Promise<void> => {
    setError(null)
    try {
      setSettings(await invoke('settings:update', next))
    } catch (err) {
      setError((err as Error).message)
    }
  }

  return (
    <>
      <div className="page-head">
        <div>
          <div className="page-title">Settings</div>
          <div className="page-sub">Harbor {version} · macOS · everything lives in {homeDir}</div>
        </div>
      </div>

      <div className="page-body">
        {error && <p className="error-text">{error}</p>}

        <div className="card-list">
          <div className="card">
            <div className="section-label">
              Environment
              <div className="grow" />
              <button
                type="button"
                className="btn xs"
                disabled={checking}
                onClick={() => void refreshDiagnostics()}
              >
                {checking ? 'Checking…' : 'Re-check'}
              </button>
            </div>

            {!diagnostics.length && (
              <div className="row">
                <span className="small muted">Checking…</span>
              </div>
            )}

            {diagnostics.map((item) => (
              <div key={item.id} className="row">
                <div>
                  <div className="k" style={{ color: 'var(--tx)' }}>
                    <span className="hstack" style={{ gap: 7 }}>
                      <StatusDot
                        status={
                          item.status === 'ok'
                            ? 'running'
                            : item.status === 'fail'
                              ? 'error'
                              : 'busy'
                        }
                        small
                      />
                      {item.label}
                    </span>
                  </div>
                  {item.remedy && <div className="hint">{item.remedy}</div>}
                </div>
                <div className="v small" style={{ color: item.status === 'ok' ? 'var(--tx2)' : 'var(--tx)' }}>
                  {item.detail}
                </div>
              </div>
            ))}
          </div>

          <div className="card">
            <div className="section-label">
              Container runtime
              <div className="grow" />
              <button
                type="button"
                className="btn xs"
                disabled={runtimeBusy !== null}
                onClick={() => void runRuntime('refresh', () => invoke('containers:list', true))}
              >
                Re-detect
              </button>
            </div>

            <div className="row">
              <div>
                <div className="k" style={{ color: 'var(--tx)' }}>Choose automatically</div>
                <div className="hint">
                  Use whichever runtime is installed and running
                </div>
              </div>
              <div className="v">
                <Toggle
                  on={preference === AUTO_RUNTIME}
                  label="Choose the container runtime automatically"
                  // Nothing detected means nothing to pin, so there is no
                  // meaningful off state to offer.
                  disabled={runtimeBusy !== null || !active}
                  onChange={(on) => {
                    if (on) {
                      void runRuntime('auto', () => invoke('containers:select', AUTO_RUNTIME))
                      return
                    }
                    /*
                     * Turning automatic off means "keep what I have now": pin
                     * whatever auto resolved to. Doing nothing — which is what
                     * this used to do — made a switch that could be turned on
                     * and never off, and read as simply broken.
                     */
                    if (!active) return
                    void runRuntime(active.id, () => invoke('containers:select', active.id))
                  }}
                />
              </div>
            </div>

            {runtimes.map((rt) => (
              <div key={rt.id} className="row">
                <div>
                  <div className="k" style={{ color: 'var(--tx)' }}>
                    <span className="hstack" style={{ gap: 7 }}>
                      <StatusDot
                        status={rt.running ? 'running' : rt.installed ? 'busy' : 'stopped'}
                        small
                      />
                      {rt.displayName}
                      {rt.selected && <span className="pill default-ver">in use</span>}
                    </span>
                  </div>
                  <div className="hint">{rt.description}</div>
                  {/* Under the description, not out at the right edge. It is
                      the longest string in the row and the column it was in is
                      the narrow one once the page splits into columns. */}
                  {!rt.installed && rt.install && (
                    <div className="hint mono" style={{ marginTop: 4 }} title="Run this in your terminal">
                      {rt.install}
                    </div>
                  )}
                </div>
                <div className="v hstack" style={{ gap: 8 }}>
                  <span className="small muted">{rt.detail}</span>
                  {/* Only offered when Harbor can genuinely do it: a GUI app has
                      to be opened by the user, and saying otherwise is a button
                      that does nothing. */}
                  {rt.installed && !rt.running && rt.startable && (
                    <button
                      type="button"
                      className="btn xs"
                      disabled={runtimeBusy !== null}
                      onClick={() => void runRuntime(rt.id, () => invoke('containers:start', rt.id))}
                    >
                      {runtimeBusy === rt.id ? 'Starting…' : 'Start'}
                    </button>
                  )}
                  {/*
                   * "Use this" beside an "in use" badge reads as a
                   * contradiction. The runtime auto picked is already in use;
                   * the action available for it is to pin that choice so it
                   * stays put when something else is installed later.
                   */}
                  {rt.installed && preference !== rt.id && (
                    <button
                      type="button"
                      className="btn xs"
                      disabled={runtimeBusy !== null}
                      onClick={() => void runRuntime(rt.id, () => invoke('containers:select', rt.id))}
                    >
                      {rt.selected ? 'Always use' : 'Use this'}
                    </button>
                  )}
                </div>
              </div>
            ))}
          </div>

          <div className="card">
            <div className="section-label">Domains &amp; TLS</div>

            <div className="row">
              <div>
                <div className="k">Local TLD</div>
                <div className="hint">Changing this re-parks every project</div>
              </div>
              <div className="v">
                <input
                  className="field-input mono"
                  style={{ width: 110 }}
                  value={tld}
                  onChange={(e) => setTld(e.target.value.replace(/^\./, ''))}
                />
                <button
                  type="button"
                  className="btn xs outline-ac"
                  disabled={busy || !tld || tld === settings?.tld}
                  onClick={() => void applyTld()}
                >
                  {busy ? 'Working…' : 'Apply'}
                </button>
                <span className="small muted">
                  {tld === settings?.tld
                    ? 'every site is re-homed on change'
                    : `re-homes every site to .${tld}`}
                </span>
              </div>
            </div>

            <div className="row">
              <div className="k" />
              <div
                className="v small"
                style={{
                  color:
                    advice.level === 'danger'
                      ? 'var(--rd)'
                      : advice.level === 'warn'
                        ? 'var(--am)'
                        : 'var(--tx3)',
                  textWrap: 'pretty'
                }}
              >
                {advice.message}
              </div>
            </div>

            <Step
              label="Certificate authority"
              hint="mkcert, trusted in the system keychain"
              ok={Boolean(status?.tls.caInstalled)}
              detail={
                status?.tls.caInstalled
                  ? 'local CA trusted'
                  : status?.tls.installed
                    ? 'installed · CA not trusted yet'
                    : 'mkcert not installed'
              }
              action={
                status?.tls.caInstalled
                  ? null
                  : status?.tls.installed
                    ? 'Trust the CA…'
                    : 'Install mkcert'
              }
              busy={busy}
              onRun={() =>
                act(status?.tls.installed ? 'tls:installCa' : 'tls:install', (next) =>
                  setStatus((s) => (s ? { ...s, tls: next as TlsStatus } : s))
                )
              }
            />
          </div>

          <div className="card">
            <div className="section-label">DNS</div>

            <Step
              label="dnsmasq"
              hint={`Answers *.${tld || 'test'} on port ${status?.dns.port ?? 5300} — no root needed`}
              ok={Boolean(status?.dns.installed)}
              detail={status?.dns.installed ? 'installed' : 'not installed'}
              action={status?.dns.installed ? null : 'Install dnsmasq'}
              busy={busy}
              onRun={() =>
                act('dns:install', (next) =>
                  setStatus((s) => (s ? { ...s, dns: next as DnsStatus } : s))
                )
              }
            />

            <Step
              label="Resolution"
              hint="Harbor runs dnsmasq itself, so it starts and stops with the app"
              ok={Boolean(status?.dns.resolves)}
              detail={
                status?.dns.resolves
                  ? `answering *.${tld || 'test'}`
                  : status?.dns.running
                    ? 'running but not answering'
                    : 'stopped'
              }
              action={status?.dns.running ? 'Stop' : 'Start'}
              busy={busy}
              onRun={() =>
                act(status?.dns.running ? 'dns:stop' : 'dns:start', (next) =>
                  setStatus((s) => (s ? { ...s, dns: next as DnsStatus } : s))
                )
              }
            />

            <Step
              label="System resolver"
              hint={`/etc/resolver/${tld || 'test'} — the only step that needs your password`}
              ok={Boolean(status?.dns.resolverConfigured)}
              detail={status?.dns.resolverConfigured ? 'configured' : 'not written'}
              action={status?.dns.resolverConfigured ? null : 'Write resolver…'}
              busy={busy}
              onRun={() =>
                act('dns:configureResolver', (next) =>
                  setStatus((s) => (s ? { ...s, dns: next as DnsStatus } : s))
                )
              }
            />

            <Step
              label="Resolver cache"
              hint="macOS keeps failed lookups; a name tried before Harbor owned the suffix stays unresolvable until this is cleared"
              ok
              detail="cleared automatically when the resolver is written"
              action="Flush now…"
              busy={busy}
              onRun={() =>
                act('dns:flush', (next) =>
                  setStatus((s) => (s ? { ...s, dns: next as DnsStatus } : s))
                )
              }
            />
          </div>

          <div className="card">
            <div className="section-label">General</div>

            <div className="row">
              <div>
                <div className="k">Start services with Harbor</div>
                <div className="hint">Launch every autoStart service when the app opens</div>
              </div>
              <div className="v">
                <Toggle
                  on={Boolean(settings?.autoStartServices)}
                  label="Start services with Harbor"
                  onChange={(autoStartServices) => void patch({ autoStartServices })}
                />
              </div>
            </div>

            <div className="row">
              <div className="k">Parked directories</div>
              <div className="v" style={{ flexWrap: 'wrap' }}>
                {settings?.parkedDirs.length ? (
                  settings.parkedDirs.map((dir) => (
                    <span key={dir} className="pill mono">
                      {dir}
                    </span>
                  ))
                ) : (
                  <span className="small muted">None yet</span>
                )}
              </div>
            </div>

            <div className="row">
              <div className="k">Harbor home</div>
              <div className="v">
                <span className="mono small" style={{ color: 'var(--tx2)' }}>
                  {homeDir}
                </span>
              </div>
            </div>
          </div>

          <div className="card">
            <div className="section-label">Updates</div>
            <Step
              label="Version"
              hint="Checked on demand, never in the background"
              ok={update?.state !== 'error'}
              detail={
                update
                  ? update.state === 'available'
                    ? `${update.currentVersion} → ${update.availableVersion} available`
                    : update.state === 'current'
                      ? `${update.currentVersion} — up to date`
                      : `${update.currentVersion} — ${update.detail ?? update.state}`
                  : version
              }
              action="Check for updates"
              busy={busy}
              onRun={() => {
                setBusy(true)
                setError(null)
                void invoke('app:checkForUpdates')
                  .then(setUpdate)
                  .catch((e: Error) => setError(e.message))
                  .finally(() => setBusy(false))
              }}
            />
          </div>

          <div className="card">
            <div className="section-label">Front door</div>

            <div className="row">
              <div>
                <div className="k">nginx</div>
                <div className="hint">Single front door for every .{tld || 'test'} domain</div>
              </div>
              <div className="v">
                <span className="hstack" style={{ gap: 6, fontSize: 12, color: 'var(--tx2)' }}>
                  <span
                    className={`dot sm ${
                      status?.nginx.running && boundCorrectly ? 'running' : status?.nginx.running ? 'busy' : 'error'
                    }`}
                  />
                  {!status?.nginx.installed
                    ? 'not installed — brew install nginx'
                    : !status.nginx.running
                      ? 'stopped'
                      : boundCorrectly
                        ? `running as ${status.nginx.runningAs} on ${listening.join(', ')}`
                        : `running as ${status.nginx.runningAs} on ${
                            listening.join(', ') || 'nothing'
                          } — needs :${settings?.httpPort}/:${settings?.httpsPort}`}
                </span>
                <button
                  type="button"
                  className={`btn xs ${boundCorrectly ? '' : 'outline-ac'}`}
                  disabled={busy || !status?.nginx.installed}
                  onClick={() => {
                    setBusy(true)
                    setError(null)
                    void invoke('nginx:restart')
                      .then((next) => setStatus((s) => (s ? { ...s, nginx: next } : s)))
                      .catch((e: Error) => setError(e.message))
                      .finally(() => setBusy(false))
                  }}
                >
                  {busy ? 'Working…' : 'Restart nginx…'}
                </button>
              </div>
            </div>
            {status?.nginx.runningAs === 'root' &&
              (!status.nginx.workerUser || status.nginx.workerUser === 'nobody') && (
                <div className="row">
                  <div className="k" />
                  <div className="v small" style={{ color: 'var(--rd)', textWrap: 'pretty' }}>
                    nginx workers are running as <span className="mono">nobody</span>, which cannot
                    read anything under your home directory — every site will return 403 or 502.
                    Restart nginx to fix it.
                  </div>
                </div>
              )}
            {status?.nginx.running && !boundCorrectly && (
              <div className="row">
                <div className="k" />
                <div className="v small muted" style={{ textWrap: 'pretty' }}>
                  A running master keeps the ports it started with, so changing them needs a
                  restart. Binding {settings && settings.httpsPort < 1024 ? '443' : 'these ports'}{' '}
                  requires your password.
                </div>
              </div>
            )}

            <div className="row">
              <div>
                <div className="k">Harbor vhosts</div>
                <div className="hint">
                  Until nginx includes them, generated vhosts are never served
                </div>
              </div>
              <div className="v">
                <span className="hstack" style={{ gap: 6, fontSize: 12, color: 'var(--tx2)' }}>
                  <span className={`dot sm ${status?.nginx.connected ? 'running' : 'error'}`} />
                  {status?.nginx.connected ? 'connected' : 'not connected'}
                </span>
                <button
                  type="button"
                  className={`btn xs ${status?.nginx.connected ? '' : 'outline-ac'}`}
                  disabled={busy || !status?.nginx.installed}
                  onClick={() => {
                    setBusy(true)
                    setError(null)
                    void invoke(status?.nginx.connected ? 'nginx:disconnect' : 'nginx:connect')
                      .then((next) => setStatus((s) => (s ? { ...s, nginx: next } : s)))
                      .catch((e: Error) => setError(e.message))
                      .finally(() => setBusy(false))
                  }}
                >
                  {busy
                    ? 'Working…'
                    : status?.nginx.connected
                      ? 'Disconnect'
                      : 'Connect nginx…'}
                </button>
              </div>
            </div>

            {status?.nginx.configPath && (
              <div className="row">
                <div className="k">Config file</div>
                <div className="v">
                  <span className="mono small" style={{ color: 'var(--tx2)' }}>
                    {status.nginx.configPath}
                  </span>
                </div>
              </div>
            )}
          </div>
        </div>
      </div>
    </>
  )
}

import { useEffect, useState } from 'react'
import type {
  AppSettings,
  DnsStatus,
  NginxStatus,
  TlsStatus,
  UpdateStatus
} from '../../../shared/ipc.js'
import { invoke } from '../ipc/client.js'
import { Toggle } from './primitives.js'

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
    channel: 'tls:install' | 'tls:installCa' | 'dns:install' | 'dns:start' | 'dns:stop' | 'dns:configureResolver',
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
  const boundCorrectly = Boolean(
    status?.nginx.running &&
      settings &&
      status.nginx.listening.includes(settings.httpPort) &&
      status.nginx.listening.includes(settings.httpsPort)
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

        <div className="stack" style={{ maxWidth: 760, gap: 14 }}>
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
                        ? `running as ${status.nginx.runningAs} on ${status.nginx.listening.join(', ')}`
                        : `running as ${status.nginx.runningAs} on ${
                            status.nginx.listening.join(', ') || 'nothing'
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

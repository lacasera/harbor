import { useEffect, useState } from 'react'
import type { AppSettings, NginxStatus } from '../../../shared/ipc.js'
import { invoke } from '../ipc/client.js'
import { Toggle } from './primitives.js'

interface SystemStatus {
  nginx: NginxStatus
  tls: { installed: boolean; caInstalled: boolean }
  dns: { installed: boolean; configured: boolean }
}

export function SettingsView({ version, homeDir }: { version: string; homeDir: string }): React.JSX.Element {
  const [settings, setSettings] = useState<AppSettings | null>(null)
  const [status, setStatus] = useState<SystemStatus | null>(null)
  const [tld, setTld] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    void invoke('settings:get').then((s) => {
      setSettings(s)
      setTld(s.tld)
    })
    void Promise.all([invoke('nginx:status'), invoke('tls:status'), invoke('dns:status')])
      .then(([nginx, tls, dns]) => setStatus({ nginx, tls, dns }))
      .catch((err: Error) => setError(err.message))
  }, [])

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
                  onBlur={() => tld && tld !== settings?.tld && void patch({ tld })}
                />
                <span className="small muted">
                  sites resolve at <span className="mono">&lt;name&gt;.{tld || 'test'}</span>
                </span>
              </div>
            </div>

            <div className="row">
              <div>
                <div className="k">Certificate authority</div>
                <div className="hint">mkcert, trusted in the system keychain</div>
              </div>
              <div className="v">
                <span className="mono small" style={{ color: 'var(--tx2)' }}>
                  {status?.tls.caInstalled
                    ? 'harbor local CA · trusted'
                    : status?.tls.installed
                      ? 'mkcert installed · CA not trusted yet'
                      : 'mkcert not installed'}
                </span>
              </div>
            </div>

            <div className="row">
              <div>
                <div className="k">DNS resolver</div>
                <div className="hint">dnsmasq answering *.{tld || 'test'}</div>
              </div>
              <div className="v">
                <span className="mono small" style={{ color: 'var(--tx2)' }}>
                  {status?.dns.configured
                    ? `/etc/resolver/${tld || 'test'} configured`
                    : status?.dns.installed
                      ? 'dnsmasq installed · resolver not written'
                      : 'dnsmasq not installed'}
                </span>
              </div>
            </div>
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
            <div className="section-label">Front door</div>

            <div className="row">
              <div>
                <div className="k">nginx</div>
                <div className="hint">Single front door for every .{tld || 'test'} domain</div>
              </div>
              <div className="v">
                <span className="mono small" style={{ color: 'var(--tx2)' }}>
                  {status?.nginx.installed
                    ? status.nginx.running
                      ? 'installed · running'
                      : 'installed · stopped'
                    : 'not installed — brew install nginx'}
                </span>
                <button
                  type="button"
                  className="btn xs"
                  disabled={!status?.nginx.installed}
                  onClick={() => void invoke('nginx:reload').catch((e: Error) => setError(e.message))}
                >
                  Reload config
                </button>
              </div>
            </div>

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

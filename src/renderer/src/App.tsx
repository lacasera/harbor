import { useCallback, useEffect, useMemo, useState } from 'react'
import type { ServiceDescriptor } from '../../shared/service.js'
import type { ProjectDescriptor } from '../../shared/project.js'
import type { RuntimeDescriptor } from '../../shared/runtime.js'
import type { ProcessHandle, ResourceUsage } from '../../shared/process.js'
import type { LogLine } from '../../shared/logs.js'
import type { Route } from './routes.js'
import { invoke, subscribe } from './ipc/client.js'
import { Sidebar, TitleBar, type RunningEntry } from './components/Shell.js'
import { ProjectsView } from './components/ProjectsView.js'
import { ProjectDetail } from './components/ProjectDetail.js'
import { ServicesView } from './components/ServicesView.js'
import { ServiceDetail } from './components/ServiceDetail.js'
import { LogsView } from './components/LogsView.js'
import { RuntimesView } from './components/RuntimesView.js'
import { SettingsView } from './components/SettingsView.js'
import { formatBytes } from './components/primitives.js'

const LOG_BUFFER = 400
const THEME_KEY = 'harbor.theme'

export function App(): React.JSX.Element {
  const [route, setRoute] = useState<Route>({ name: 'projects' })
  const [theme, setTheme] = useState<'dark' | 'light'>(
    () => (localStorage.getItem(THEME_KEY) as 'dark' | 'light' | null) ?? 'dark'
  )

  const [services, setServices] = useState<ServiceDescriptor[]>([])
  const [projects, setProjects] = useState<ProjectDescriptor[]>([])
  const [runtimes, setRuntimes] = useState<RuntimeDescriptor[]>([])
  const [processes, setProcesses] = useState<ProcessHandle[]>([])
  const [usage, setUsage] = useState<ResourceUsage[]>([])
  const [logs, setLogs] = useState<LogLine[]>([])
  const [sources, setSources] = useState<string[]>([])
  const [follow, setFollow] = useState(true)
  const [app, setApp] = useState({ name: 'Harbor', version: '0.0.0', homeDir: '' })
  const [parkedDirs, setParkedDirs] = useState<string[]>([])

  const reloadServices = useCallback(() => {
    void invoke('services:list').then(setServices)
  }, [])
  const reloadProjects = useCallback(() => {
    void invoke('projects:list').then(setProjects)
    void invoke('settings:get').then((s) => setParkedDirs(s.parkedDirs))
  }, [])
  const reloadRuntimes = useCallback(() => {
    void invoke('runtimes:list').then(setRuntimes)
  }, [])

  useEffect(() => {
    reloadServices()
    reloadProjects()
    reloadRuntimes()
    void invoke('app:info').then(setApp)
    void invoke('processes:list').then(setProcesses)
    // Seed the CPU/RAM pill so it isn't zeroed until the first sample arrives.
    void invoke('processes:usage').then(setUsage)
    void invoke('logs:query', { limit: LOG_BUFFER }).then(setLogs)
    void invoke('logs:sources').then(setSources)
  }, [reloadServices, reloadProjects, reloadRuntimes])

  useEffect(() => {
    document.documentElement.setAttribute('data-theme', theme)
    localStorage.setItem(THEME_KEY, theme)
  }, [theme])

  // Main pushes on every state change, so nothing here polls.
  useEffect(
    () =>
      subscribe('service:changed', (next) =>
        setServices((prev) => prev.map((s) => (s.id === next.id ? next : s)))
      ),
    []
  )
  useEffect(
    () =>
      subscribe('project:changed', (next) =>
        setProjects((prev) => prev.map((p) => (p.id === next.id ? next : p)))
      ),
    []
  )
  useEffect(
    () =>
      subscribe('process:changed', (next) =>
        setProcesses((prev) => {
          const idx = prev.findIndex((p) => p.id === next.id)
          if (idx === -1) return [...prev, next]
          const copy = [...prev]
          copy[idx] = next
          return copy
        })
      ),
    []
  )
  useEffect(() => subscribe('usage:sample', setUsage), [])
  useEffect(
    () =>
      subscribe('log:line', (line) => {
        // Paused means the buffer stops growing — the design's "Following" toggle.
        if (!follow) return
        setLogs((prev) => [...prev, line].slice(-LOG_BUFFER))
        setSources((prev) => (prev.includes(line.source) ? prev : [...prev, line.source]))
      }),
    [follow]
  )

  const runningProjects = projects.filter((p) => p.running)
  const runningServices = services.filter((s) => s.status.health === 'running')

  const running: RunningEntry[] = useMemo(
    () => [
      ...runningServices.map((s) => ({
        id: s.id,
        name: s.displayName,
        port: String(s.status.ports[0] ?? s.defaultPorts[0] ?? ''),
        go: () => setRoute({ name: 'service', id: s.id })
      })),
      ...runningProjects.map((p) => ({
        id: p.id,
        name: p.name,
        port: p.port ? `:${p.port}` : '',
        go: () => setRoute({ name: 'project', id: p.id })
      }))
    ],
    [runningServices, runningProjects]
  )

  const totals = useMemo(() => {
    const cpu = usage.reduce((n, u) => n + u.cpu, 0)
    const mem = usage.reduce((n, u) => n + u.memory, 0)
    return { cpu: `${cpu.toFixed(1)}%`, ram: mem ? formatBytes(mem) : '0 MB' }
  }, [usage])

  const project = route.name === 'project' ? projects.find((p) => p.id === route.id) : undefined
  const service = route.name === 'service' ? services.find((s) => s.id === route.id) : undefined

  return (
    <div className="app">
      <TitleBar
        runningCount={running.length}
        cpu={totals.cpu}
        ram={totals.ram}
        theme={theme}
        onToggleTheme={() => setTheme((t) => (t === 'dark' ? 'light' : 'dark'))}
      />

      <div className="body">
        <Sidebar
          route={route}
          onNavigate={setRoute}
          counts={{ projects: runningProjects.length, services: runningServices.length }}
          running={running}
          version={app.version}
        />

        <div className="main">
          {route.name === 'projects' && (
            <ProjectsView
              projects={projects}
              parkedDirs={parkedDirs}
              onOpen={(id) => setRoute({ name: 'project', id })}
              onReload={reloadProjects}
            />
          )}

          {route.name === 'project' &&
            (project ? (
              <ProjectDetail
                project={project}
                services={services}
                runtimes={runtimes}
                processes={processes}
                usage={usage}
                logs={logs}
                onBack={() => setRoute({ name: 'projects' })}
                onChanged={(next) =>
                  setProjects((prev) => prev.map((p) => (p.id === next.id ? next : p)))
                }
                onOpenServices={() => setRoute({ name: 'services' })}
                onOpenLogs={() => setRoute({ name: 'logs' })}
              />
            ) : (
              <Missing what="project" onBack={() => setRoute({ name: 'projects' })} />
            ))}

          {route.name === 'services' && (
            <ServicesView
              services={services}
              processes={processes}
              usage={usage}
              onOpen={(id) => setRoute({ name: 'service', id })}
              onChanged={(next) =>
                setServices((prev) => prev.map((s) => (s.id === next.id ? next : s)))
              }
            />
          )}

          {route.name === 'service' &&
            (service ? (
              <ServiceDetail
                service={service}
                catalogue={services}
                processes={processes}
                usage={usage}
                logs={logs}
                onBack={() => setRoute({ name: 'services' })}
                onChanged={(next) =>
                  setServices((prev) => prev.map((s) => (s.id === next.id ? next : s)))
                }
                onOpenLogs={() => setRoute({ name: 'logs' })}
              />
            ) : (
              <Missing what="service" onBack={() => setRoute({ name: 'services' })} />
            ))}

          {route.name === 'runtimes' && (
            <RuntimesView runtimes={runtimes} projects={projects} onReload={reloadRuntimes} />
          )}

          {route.name === 'logs' && (
            <LogsView
              lines={logs}
              sources={sources}
              follow={follow}
              onToggleFollow={() => setFollow((f) => !f)}
              onClear={() => void invoke('logs:clear').then(() => setLogs([]))}
            />
          )}

          {route.name === 'settings' && (
            <SettingsView version={app.version} homeDir={app.homeDir} />
          )}
        </div>
      </div>
    </div>
  )
}

function Missing({ what, onBack }: { what: string; onBack: () => void }): React.JSX.Element {
  return (
    <div className="page-body">
      <div className="empty">
        <h3>That {what} is gone</h3>
        <p>It was removed while you were looking at it.</p>
        <div className="actions">
          <button type="button" className="btn primary" onClick={onBack}>
            Back
          </button>
        </div>
      </div>
    </div>
  )
}

import { useCallback, useEffect, useMemo, useState } from 'react'
import type { ServiceDescriptor, ServiceInstanceDescriptor } from '../../shared/service.js'
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
import { Toasts } from './components/Toasts.js'
import { formatBytes } from './components/primitives.js'
import { sourceLabels } from './components/log-labels.js'

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

  /**
   * Fold one instance into the catalogue it belongs to. Everything that changes
   * a service now changes an instance, and the catalogue entry is just where
   * the renderer keeps them.
   */
  const mergeInstance = useCallback((next: ServiceInstanceDescriptor) => {
    setServices((prev) =>
      prev.map((s) =>
        s.id === next.serviceId
          ? {
              ...s,
              instances: s.instances.some((i) => i.key === next.key)
                ? s.instances.map((i) => (i.key === next.key ? next : i))
                : [...s.instances, next]
            }
          : s
      )
    )
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
      // A push carries one instance, so it is merged into the catalogue entry
      // that owns it rather than replacing a top-level service.
      subscribe('service:changed', mergeInstance),
    []
  )
  useEffect(
    () =>
      // A detached instance has to leave the catalogue, or the project's
      // Services tab keeps listing a service that no longer exists.
      subscribe('service:detached', (key) =>
        setServices((prev) =>
          prev.map((s) => ({ ...s, instances: s.instances.filter((i) => i.key !== key) }))
        )
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
      // Every removal path lands here, rather than each one remembering to
      // reload: forgetting from the detail page navigated back to a list that
      // still had the project in it.
      subscribe('project:forgotten', (id) => {
        setProjects((prev) => prev.filter((p) => p.id !== id))
        // Viewing the project that just went away would render "missing"; the
        // list is the only sensible place to be.
        setRoute((r) => (r.name === 'project' && r.id === id ? { name: 'projects' } : r))
      }),
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

  const runningProjects = projects.filter((p) => p.served)
  // Flattened across owners: what is running is an instance, and two projects'
  // MySQLs are two entries on different ports, not one.
  const runningServices = useMemo(
    () =>
      services.flatMap((s) =>
        s.instances
          .filter((i) => i.status.health === 'running')
          .map((i) => ({ service: s, instance: i }))
      ),
    [services]
  )

  const running: RunningEntry[] = useMemo(
    () => [
      ...runningServices.map(({ service, instance }) => ({
        id: instance.key,
        name: instance.displayName,
        port: String(instance.status.ports[0] ?? service.defaultPorts[0] ?? ''),
        go: () => setRoute({ name: 'service', id: service.id })
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

  // Derived, not stored: a source id is stable and a project's name is not.
  const logLabels = useMemo(() => sourceLabels(projects, services), [projects, services])

  const totals = useMemo(() => {
    if (!usage.length) return { cpu: '—', ram: '—' }
    const cpu = usage.reduce((n, u) => n + u.cpu, 0)
    const mem = usage.reduce((n, u) => n + u.memory, 0)
    return { cpu: `${cpu.toFixed(1)}%`, ram: mem ? formatBytes(mem) : '—' }
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
          counts={{
            projects: { total: projects.length, running: runningProjects.length },
            services: { total: services.length, running: runningServices.length }
          }}
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
                onInstanceChanged={mergeInstance}
                onCatalogueChanged={setServices}
                onOpenServices={() => setRoute({ name: 'services' })}
                onOpenLogs={() => setRoute({ name: 'logs' })}
              />
            ) : (
              <Missing what="project" onBack={() => setRoute({ name: 'projects' })} />
            ))}

          {route.name === 'services' && (
            <ServicesView
              services={services}
              onOpen={(id) => setRoute({ name: 'service', id })}
              onChanged={mergeInstance}
            />
          )}

          {route.name === 'service' &&
            (service ? (
              <ServiceDetail
                service={service}
                catalogue={services}
                projects={projects}
                processes={processes}
                usage={usage}
                logs={logs}
                onBack={() => setRoute({ name: 'services' })}
                onChanged={mergeInstance}
                onCatalogueChanged={setServices}
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
              labels={logLabels}
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

      <Toasts />
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

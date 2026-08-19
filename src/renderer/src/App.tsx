import { useCallback, useEffect, useState } from 'react'
import type { ServiceDescriptor } from '../../shared/service.js'
import type { ProjectDescriptor } from '../../shared/project.js'
import type { RuntimeDescriptor } from '../../shared/runtime.js'
import { invoke, subscribe } from './ipc/client.js'
import { ServiceCard } from './components/ServiceCard.js'
import { ProjectList } from './components/ProjectList.js'
import { ProjectOverview } from './components/ProjectOverview.js'
import { RuntimePanel } from './components/RuntimePanel.js'
import { LogViewer } from './components/LogViewer.js'

type Tab = 'projects' | 'services' | 'runtimes' | 'logs'

const TABS: Array<{ id: Tab; label: string }> = [
  { id: 'projects', label: 'Projects' },
  { id: 'services', label: 'Services' },
  { id: 'runtimes', label: 'Runtimes' },
  { id: 'logs', label: 'Logs' }
]

export function App(): React.JSX.Element {
  const [tab, setTab] = useState<Tab>('projects')
  const [services, setServices] = useState<ServiceDescriptor[]>([])
  const [projects, setProjects] = useState<ProjectDescriptor[]>([])
  const [runtimes, setRuntimes] = useState<RuntimeDescriptor[]>([])
  const [inspecting, setInspecting] = useState<ProjectDescriptor | null>(null)

  const reloadServices = useCallback(() => {
    void invoke('services:list').then(setServices)
  }, [])
  const reloadProjects = useCallback(() => {
    void invoke('projects:list').then(setProjects)
  }, [])
  const reloadRuntimes = useCallback(() => {
    void invoke('runtimes:list').then(setRuntimes)
  }, [])

  useEffect(() => {
    reloadServices()
    reloadProjects()
    reloadRuntimes()
  }, [reloadServices, reloadProjects, reloadRuntimes])

  // Main pushes descriptors on every state change, so the UI never polls.
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

  return (
    <div className="app">
      <header className="titlebar">
        <h1>Harbor</h1>
        <nav className="tabs">
          {TABS.map((t) => (
            <button
              key={t.id}
              type="button"
              className={`tab ${tab === t.id ? 'active' : ''}`}
              onClick={() => setTab(t.id)}
            >
              {t.label}
            </button>
          ))}
        </nav>
      </header>

      <main className="content">
        {tab === 'projects' &&
          (inspecting ? (
            <ProjectOverview project={inspecting} onClose={() => setInspecting(null)} />
          ) : (
            <ProjectList
              projects={projects}
              onChanged={(next) =>
                setProjects((prev) => prev.map((p) => (p.id === next.id ? next : p)))
              }
              onReload={reloadProjects}
              onInspect={setInspecting}
            />
          ))}

        {tab === 'services' && (
          <div className="cards">
            {services.map((service) => (
              <ServiceCard
                key={service.id}
                service={service}
                onChanged={(next) =>
                  setServices((prev) => prev.map((s) => (s.id === next.id ? next : s)))
                }
              />
            ))}
          </div>
        )}

        {tab === 'runtimes' && <RuntimePanel runtimes={runtimes} onReload={reloadRuntimes} />}
        {tab === 'logs' && <LogViewer />}
      </main>
    </div>
  )
}

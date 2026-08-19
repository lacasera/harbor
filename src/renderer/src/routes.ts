/** Every screen in the design, as a discriminated union. */
export type Route =
  | { name: 'projects' }
  | { name: 'project'; id: string }
  | { name: 'services' }
  | { name: 'service'; id: string }
  | { name: 'runtimes' }
  | { name: 'logs' }
  | { name: 'settings' }

export type ProjectTab = 'overview' | 'env' | 'insights' | 'logs'
export type ServiceTab = 'config' | 'env' | 'logs'
export type InsightTab = 'erd' | 'deps' | 'uml'

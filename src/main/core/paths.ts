import { homedir } from 'node:os'
import { join } from 'node:path'
import { mkdirSync } from 'node:fs'

export const APP_NAME = 'harbor'

/** Everything Harbor owns lives under here. We never write outside it. */
export const HARBOR_HOME = join(homedir(), `.${APP_NAME}`)

export const paths = {
  home: HARBOR_HOME,
  config: join(HARBOR_HOME, 'config.json'),
  runtimes: join(HARBOR_HOME, 'runtimes'),
  services: join(HARBOR_HOME, 'services'),
  logs: join(HARBOR_HOME, 'logs'),
  data: join(HARBOR_HOME, 'data'),
  certs: join(HARBOR_HOME, 'certs'),
  nginx: join(HARBOR_HOME, 'nginx'),
  vhosts: join(HARBOR_HOME, 'nginx', 'sites'),
  compose: join(HARBOR_HOME, 'compose'),
  bin: join(HARBOR_HOME, 'bin')
} as const

export function ensureDirs(): void {
  for (const dir of Object.values(paths)) {
    if (dir === paths.config) continue
    mkdirSync(dir, { recursive: true })
  }
}

export function runtimeDir(runtime: string, version: string): string {
  return join(paths.runtimes, runtime, version)
}

export function serviceDir(serviceId: string): string {
  return join(paths.services, serviceId)
}

export function serviceDataDir(serviceId: string): string {
  return join(paths.data, serviceId)
}

export function serviceLogFile(serviceId: string): string {
  return join(paths.logs, `${serviceId}.log`)
}

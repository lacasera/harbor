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
  bin: join(HARBOR_HOME, 'bin'),
  /** Sockets and pid files for processes Harbor runs. */
  run: join(HARBOR_HOME, 'run'),
  php: join(HARBOR_HOME, 'php')
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

/**
 * Data and logs are per instance, not per service: two projects running MySQL
 * must not share a directory. Binaries stay under `serviceDir` — installing
 * MinIO once for the machine is correct.
 */
export function serviceDataDir(owner: string, serviceId: string): string {
  return join(paths.data, owner, serviceId)
}

export function serviceLogFile(owner: string, serviceId: string): string {
  return join(paths.logs, `${owner}-${serviceId}.log`)
}

/** Where one owner's compose file and mounted config live. */
export function composeDir(composeProject: string): string {
  return join(paths.compose, composeProject)
}

/** The legacy single compose project, from before stacks were per-project. */
export const LEGACY_COMPOSE_PROJECT = 'compose'

/**
 * Compose project name for a Harbor project: `harbor-<name>`.
 *
 * The `harbor-` prefix is load-bearing, not decoration. Teardown is scoped by
 * compose project name, and the user runs their own stacks on this machine —
 * the prefix is what keeps `docker compose down` from ever reaching one of
 * them. Docker only accepts `[a-z0-9][a-z0-9_-]*`, so the name is slugged.
 *
 * `taken` disambiguates: two directories can both be named `api`, and a
 * collision would put two projects' containers and volumes in one namespace.
 */
export function composeProjectName(name: string, taken: Iterable<string> = []): string {
  const slug = name.toLowerCase().replace(/[^a-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '') || 'project'
  const used = new Set(taken)
  const base = `${APP_NAME}-${slug}`
  if (!used.has(base)) return base
  for (let n = 2; ; n++) {
    const candidate = `${base}-${n}`
    if (!used.has(candidate)) return candidate
  }
}

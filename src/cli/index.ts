/**
 * The `harbor` command.
 *
 * A thin client. Every command is a call to the running app over its local
 * socket, so the CLI and the window can never disagree about what is parked,
 * what is running, or which PHP a project uses — there is one owner of that
 * state and this is not it.
 */
import { connect } from 'node:net'
import { dirname, join, resolve } from 'node:path'
import { homedir } from 'node:os'
import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'

import { promisify } from 'node:util'

const SOCKET = join(homedir(), '.harbor', 'run', 'harbor.sock')

interface Reply {
  id: number
  result?: unknown
  error?: string
}

/**
 * The app bundle this command belongs to.
 *
 * The launcher runs the app's own binary, so `process.execPath` is inside the
 * bundle — walking up to the `.app` is how the command finds the application it
 * is part of, without hardcoding /Applications or reading a config file.
 */
function appBundle(): string | null {
  let dir = dirname(process.execPath)
  for (let i = 0; i < 5; i++) {
    if (dir.endsWith('.app') && existsSync(join(dir, 'Contents', 'MacOS'))) return dir
    dir = dirname(dir)
  }
  return null
}

/**
 * Start Harbor without showing a window, and wait for it to answer.
 *
 * The app is what serves the user's sites, so a command that needs it is
 * really asking for the daemon. `-g` keeps it out of the foreground and
 * `--hidden` keeps the window closed: running `harbor list` should not throw a
 * window in front of whatever the user was doing.
 */
async function startApp(): Promise<boolean> {
  const bundle = appBundle()
  if (!bundle || !bundle.endsWith('Harbor.app')) return false

  await promisify(execFile)('/usr/bin/open', ['-g', '-a', bundle, '--args', '--hidden']).catch(
    () => undefined
  )

  // Starting takes a moment; a fixed sleep would be either a stall or a
  // coin toss, so wait for the socket to actually answer.
  for (let i = 0; i < 60; i++) {
    if (existsSync(SOCKET)) {
      const answered = await call<unknown>('app:info')
        .then(() => true)
        .catch(() => false)
      if (answered) return true
    }
    await new Promise((r) => setTimeout(r, 500))
  }
  return false
}

/** One request, one reply, one connection. Commands are not chatty. */
function call<T>(channel: string, args: unknown[] = []): Promise<T> {
  return new Promise<T>((resolvePromise, reject) => {
    const socket = connect(SOCKET)
    let buffer = ''
    socket.on('connect', () => socket.write(`${JSON.stringify({ id: 1, channel, args })}\n`))
    socket.on('data', (chunk) => {
      buffer += chunk.toString()
      const newline = buffer.indexOf('\n')
      if (newline === -1) return
      socket.end()
      const reply = JSON.parse(buffer.slice(0, newline)) as Reply
      if (reply.error) reject(new Error(reply.error))
      else resolvePromise(reply.result as T)
    })
    socket.on('error', (err: NodeJS.ErrnoException) => {
      reject(
        err.code === 'ENOENT' || err.code === 'ECONNREFUSED'
          ? Object.assign(new Error('Harbor is not running.'), { notRunning: true })
          : err
      )
    })
  })
}

// ── shared shapes, kept minimal so the CLI bundles small ──────────────────
interface Project {
  id: string
  name: string
  path: string
  domain: string
  secure: boolean
  typeId: string
  serveModel: string
  served: boolean
  servedBy: string | null
  servedProblem: string | null
  url: string
  resolvedRuntime: { runtime: string; version: string } | null
}
interface Instance {
  key: string
  owner: string
  serviceId: string
  displayName: string
  status: { health: string; ports: number[]; detail?: string; error?: string }
}
interface ServiceEntry {
  id: string
  displayName: string
  instances: Instance[]
}
interface EnvBlock {
  displayName: string
  vars: Array<{ key: string; value: string }>
}
interface Diagnostic {
  label: string
  status: 'ok' | 'warn' | 'fail'
  detail: string
  remedy?: string
}
interface TunnelCapability {
  provider: string
  displayName: string
  installed: boolean
  authenticated: boolean
  authHint?: string
  hostname: 'reserved' | 'ephemeral' | 'unknown'
  detail?: string
}
interface ActiveTunnel {
  projectName: string
  domain: string
  provider: string
  url: string | null
  hostname: string
  restarts: number
  state: string
}
interface TunnelStatus {
  defaultProvider: string
  providers: TunnelCapability[]
  active: ActiveTunnel[]
}

const args = process.argv.slice(2)
const json = args.includes('--json')
const rest = args.filter((a) => a !== '--json')
const [command, ...params] = rest

const out = (value: unknown): void => {
  console.log(typeof value === 'string' ? value : JSON.stringify(value, null, 2))
}
const fail = (message: string): never => {
  console.error(message)
  process.exit(1)
}

/** The project a command applies to, and how that was decided. */
interface Scope {
  project: Project
  source: 'argument' | 'HARBOR_PROJECT' | 'directory'
}

/**
 * Resolve which project a command is about.
 *
 * In order: what you typed, the scope you set, then where you are standing.
 * Argument first because it is the most explicit thing in the room — a scope
 * that could override an argument would make `harbor env other-project` a lie.
 */
async function resolveScope(name?: string, options: { soft?: boolean } = {}): Promise<Scope | null> {
  /** Report and stop, unless the caller only wanted to know. */
  const give = (message: string): null => {
    if (options.soft) return null
    return fail(message)
  }

  const projects = await call<Project[]>('projects:list')
  const byName = (wanted: string): Project | undefined =>
    projects.find((p) => p.name === wanted || p.domain === wanted)

  if (name) {
    const match = byName(name)
    if (!match) return give(`No project named "${name}". Try: harbor list`)
    return { project: match, source: 'argument' }
  }

  const scoped = process.env.HARBOR_PROJECT
  if (scoped) {
    const match = byName(scoped)
    if (!match) return give(`HARBOR_PROJECT is set to "${scoped}", which is not a project.`)
    return { project: match, source: 'HARBOR_PROJECT' }
  }

  // Walk up. Matching only the exact directory meant that standing anywhere
  // inside a project — its `app` folder, its `public` folder — found nothing,
  // which is most of the time you are actually in one.
  let dir = process.cwd()
  for (;;) {
    const match = projects.find((p) => p.path === dir)
    if (match) return { project: match, source: 'directory' }
    const parent = dirname(dir)
    if (parent === dir) break
    dir = parent
  }

  return give('Not inside a project. Name one, or set a scope:\n  eval "$(harbor scope <name>)"')
}

async function findProject(name?: string): Promise<Project> {
  return (await resolveScope(name))!.project
}

const HELP = `harbor — local development platform

  harbor scope [name]              show the project commands apply to,
                                   or print the line to set it:
                                     eval "$(harbor scope api)"
                                   harbor scope --clear to drop it

  harbor status                    what is installed, running and wrong
  harbor list                      parked and linked projects
  harbor park [dir]                serve every subdirectory of a folder
  harbor link [dir]                serve one folder
  harbor forget [name]             stop serving a project
  harbor open [name]               open a project in the browser
  harbor secure [name]             issue a certificate and serve over HTTPS
  harbor unsecure [name]
  harbor which [name]              the runtime a project resolves to
  harbor use <runtime@version> [name]
                                   pin a project to a runtime version
  harbor env [name]                the .env block for a project's services
  harbor tunnel [name]             expose a project publicly, print the URL
  harbor tunnel stop [name]        take the tunnel down
  harbor tunnel status             which projects are exposed, and where
  harbor services [name]           service instances, all or for one project
  harbor start [name] [service]    start a project's services
  harbor stop [name] [service]     stop them
  harbor logs [--lines N]          recent output from everything
  harbor tld [name]                show or change the local TLD
  harbor restart nginx|dns         restart a piece of the plumbing

Commands taking [name] use it if given, then HARBOR_PROJECT, then the
project containing the directory you are in.

  --json                           machine-readable output for any command`

async function main(): Promise<void> {
  switch (command) {
    case undefined:
    case 'help':
    case '--help':
    case '-h':
      return out(HELP)

    case 'version':
    case '--version': {
      const info = await call<{ version: string }>('app:info')
      return out(json ? info : info.version)
    }

    case 'status': {
      const checks = await call<Diagnostic[]>('app:diagnostics')
      if (json) return out(checks)
      const mark = { ok: ' ok ', warn: 'warn', fail: 'FAIL' }
      for (const c of checks) {
        out(`  ${mark[c.status]}  ${c.label.padEnd(20)} ${c.detail}`)
        if (c.remedy && c.status !== 'ok') out(`        ${c.remedy}`)
      }
      return
    }

    case 'list':
    case 'links':
    case 'projects': {
      const projects = await call<Project[]>('projects:list')
      if (json) return out(projects)
      if (!projects.length) return out('No projects. Try: harbor park ~/Sites')
      for (const p of projects) {
        const state = p.served ? (p.servedBy ?? 'served') : (p.servedProblem ?? 'not served')
        out(`  ${p.name.padEnd(22)} ${p.url.padEnd(34)} ${state}`)
      }
      return
    }

    /*
     * Scope is an environment variable, not something Harbor remembers.
     *
     * A remembered "current project" is one setting shared by every terminal:
     * set it in one window, and a `harbor forget` in another — with no argument
     * and nothing on screen to say why — removes a project you were not looking
     * at. A variable belongs to the shell that set it, which is the boundary
     * people already expect from `cd` and from every version manager.
     */
    case 'scope': {
      if (params[0] === '--clear' || params[0] === 'off') {
        return out(json ? { clear: true } : 'unset HARBOR_PROJECT')
      }
      if (params[0]) {
        const project = await findProject(params[0])
        if (json) return out({ project: project.name })
        // Printed for eval rather than executed: a child process cannot change
        // its parent shell's environment, and pretending otherwise would leave
        // the user wondering why nothing happened.
        return out(`export HARBOR_PROJECT=${project.name}`)
      }
      // Asking what the scope is should never be an error: "nothing" is a
      // perfectly good answer to that question.
      const scope = await resolveScope(undefined, { soft: true })
      if (!scope) {
        return out(
          json
            ? { project: null, source: null }
            : 'No project in scope. Stand in one, or: eval "$(harbor scope <name>)"'
        )
      }
      const how = {
        argument: 'named on the command line',
        HARBOR_PROJECT: 'set by HARBOR_PROJECT',
        directory: `from the directory you are in (${scope.project.path})`
      }
      return out(
        json
          ? { project: scope.project.name, source: scope.source }
          : `${scope.project.name} — ${how[scope.source]}`
      )
    }

    case 'paths': {
      const settings = await call<{ parkedDirs: string[] }>('settings:get')
      return out(json ? settings.parkedDirs : settings.parkedDirs.join('\n') || '(none parked)')
    }

    case 'park': {
      const dir = resolve(params[0] ?? process.cwd())
      const parked = await call<Project[]>('projects:park', [dir])
      return out(json ? parked : `Parked ${dir} — ${parked.length} project(s)`)
    }

    case 'link': {
      const dir = resolve(params[0] ?? process.cwd())
      const project = await call<Project>('projects:link', [dir])
      return out(json ? project : `Serving ${project.url}`)
    }

    case 'forget':
    case 'unlink': {
      const project = await findProject(params[0])
      await call('projects:forget', [project.id])
      return out(json ? { forgotten: project.name } : `Forgot ${project.name}`)
    }

    case 'open': {
      const project = await findProject(params[0])
      await call('app:openExternal', [project.url])
      return out(json ? { opened: project.url } : `Opened ${project.url}`)
    }

    case 'secure':
    case 'unsecure': {
      const project = await findProject(params[0])
      const updated = await call<Project>('projects:update', [
        project.id,
        { secure: command === 'secure' }
      ])
      return out(json ? updated : `${updated.name} is now ${updated.url}`)
    }

    case 'which':
    case 'which-php': {
      const project = await findProject(params[0])
      const runtime = project.resolvedRuntime
      if (!runtime) return out(`${project.name}: no runtime resolved`)
      return out(json ? runtime : `${project.name}: ${runtime.runtime} ${runtime.version}`)
    }

    case 'use': {
      const spec = params[0]
      if (!spec?.includes('@')) fail('Usage: harbor use php@8.4 [project]')
      const [runtime, version] = spec.split('@')
      const project = await findProject(params[1])
      const updated = await call<Project>('projects:update', [
        project.id,
        { runtimeOverride: { runtime, version } }
      ])
      return out(json ? updated : `${updated.name} pinned to ${runtime} ${version}`)
    }

    case 'env': {
      const project = await findProject(params[0])
      const services = await call<ServiceEntry[]>('services:list')
      const refs = services
        .flatMap((s) => s.instances)
        .filter((i) => i.owner === project.id)
        .map((i) => ({ owner: i.owner, serviceId: i.serviceId }))
      if (!refs.length) return out(`${project.name} has no services attached.`)
      const blocks = await call<EnvBlock[]>('services:envBlocks', [refs])
      if (json) return out(blocks)
      for (const block of blocks) {
        out(`# ${block.displayName}`)
        for (const v of block.vars) out(`${v.key}=${v.value}`)
        out('')
      }
      return
    }

    case 'services': {
      const services = await call<ServiceEntry[]>('services:list')
      const projects = await call<Project[]>('projects:list')
      const names = new Map(projects.map((p) => [p.id, p.name]))
      const only = params[0] ? (await findProject(params[0])).id : null
      const rows = services
        .flatMap((s) => s.instances)
        .filter((i) => !only || i.owner === only)
      if (json) return out(rows)
      if (!rows.length) return out('No services attached.')
      for (const i of rows) {
        const where = names.get(i.owner) ?? i.owner
        const ports = i.status.ports.join(', ')
        out(`  ${where.padEnd(20)} ${i.displayName.padEnd(16)} ${i.status.health.padEnd(9)} ${ports}`)
      }
      return
    }

    case 'start':
    case 'stop': {
      const project = await findProject(params[0])
      const service = params[1]
      if (service) {
        const ref = { owner: project.id, serviceId: service }
        const instance = await call<Instance>(`services:${command}`, [ref])
        return out(json ? instance : `${service}: ${instance.status.health}`)
      }
      await call(`projects:${command}Stack`, [project.id])
      return out(json ? { ok: true } : `${command === 'start' ? 'Started' : 'Stopped'} ${project.name}'s services`)
    }

    case 'logs':
    case 'log': {
      const at = rest.indexOf('--lines')
      const limit = at === -1 ? 40 : Number(rest[at + 1] ?? 40)
      const lines = await call<Array<{ source: string; message: string }>>('logs:query', [{ limit }])
      if (json) return out(lines)
      for (const l of lines) out(`${l.source.slice(0, 22).padEnd(22)} ${l.message}`)
      return
    }

    case 'tld': {
      if (!params[0]) {
        const settings = await call<{ tld: string }>('settings:get')
        return out(json ? settings : settings.tld)
      }
      const updated = await call<{ tld: string }>('settings:update', [{ tld: params[0] }])
      return out(json ? updated : `Local TLD is now .${updated.tld}`)
    }

    case 'tunnel': {
      const sub = params[0]

      if (sub === 'status') {
        const status = await call<TunnelStatus>('tunnel:status')
        if (json) return out(status)
        out(`Default provider: ${status.defaultProvider}`)
        for (const p of status.providers) {
          const state = !p.installed
            ? 'not installed'
            : !p.authenticated
              ? 'not authenticated'
              : `ready (${p.hostname})`
          out(`  ${p.displayName.padEnd(20)} ${state}`)
          if (p.authHint && !p.authenticated) out(`        ${p.authHint}`)
        }
        if (!status.active.length) return out('\nNo projects are exposed.')
        out('\nExposed now:')
        for (const t of status.active) {
          out(`  ${t.domain.padEnd(24)} ${t.url ?? `(${t.state})`}  via ${t.provider}`)
        }
        return
      }

      if (sub === 'stop') {
        const project = await findProject(params[1])
        const status = await call<TunnelStatus>('tunnel:stop', [project.id])
        return out(json ? status : `Stopped tunnel for ${project.name} — no longer public`)
      }

      const project = await findProject(sub)
      let status = await call<TunnelStatus>('tunnel:status')
      const provider = status.defaultProvider
      let cap = status.providers.find((p) => p.provider === provider)

      // Harbor installs the provider itself rather than failing with a bare
      // "command not found" — the same shape as runtimes:install and the rest.
      if (cap && !cap.installed) {
        process.stderr.write(`Installing ${cap.displayName}…\n`)
        status = await call<TunnelStatus>('tunnel:install', [provider])
        cap = status.providers.find((p) => p.provider === provider)
      }
      if (cap && !cap.authenticated) {
        return fail(cap.authHint ?? `${cap.displayName} is not authenticated.`)
      }

      const tunnel = await call<ActiveTunnel>('tunnel:start', [project.id, provider])
      if (json) return out(tunnel)
      out(`⚠  ${project.name} is now PUBLIC`)
      out(`   ${tunnel.url ?? 'connecting… run: harbor tunnel status'}`)
      out(`   Serving ${tunnel.domain} to anyone with the link, via ${tunnel.provider}.`)
      if (tunnel.hostname === 'ephemeral') {
        out('   The URL changes if the tunnel restarts.')
      }
      out(`   Exposure ends when Harbor quits, or: harbor tunnel stop ${project.name}`)
      return
    }

    case 'restart': {
      const what = params[0]
      if (what === 'nginx') {
        await call('nginx:restart')
        return out('nginx restarted')
      }
      if (what === 'dns') {
        await call('dns:start')
        return out('DNS restarted')
      }
      return fail('Usage: harbor restart nginx|dns')
    }

    default:
      return fail(`Unknown command: ${command}\n\n${HELP}`)
  }
}

void main().catch(async (err: Error & { notRunning?: boolean }) => {
  if (!err.notRunning) {
    console.error(err.message)
    process.exit(1)
  }
  // Start it and try once more, rather than telling the user to go and do it.
  process.stderr.write('Starting Harbor…\n')
  if (!(await startApp())) {
    console.error('Could not start Harbor. Open the app and try again.')
    process.exit(1)
  }
  await main().catch((second: Error) => {
    console.error(second.message)
    process.exit(1)
  })
})

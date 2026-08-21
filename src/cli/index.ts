/**
 * The `harbor` command.
 *
 * A thin client. Every command is a call to the running app over its local
 * socket, so the CLI and the window can never disagree about what is parked,
 * what is running, or which PHP a project uses — there is one owner of that
 * state and this is not it.
 */
import { connect } from 'node:net'
import { basename, join, resolve } from 'node:path'
import { homedir } from 'node:os'

const SOCKET = join(homedir(), '.harbor', 'run', 'harbor.sock')

interface Reply {
  id: number
  result?: unknown
  error?: string
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
          ? new Error('Harbor is not running. Open the app and try again.')
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

/** Resolve a project by name, domain, or the directory you are standing in. */
async function findProject(name?: string): Promise<Project> {
  const projects = await call<Project[]>('projects:list')
  const wanted = name ?? basename(process.cwd())
  const byPath = projects.find((p) => p.path === process.cwd())
  const match =
    projects.find((p) => p.name === wanted || p.domain === wanted) ?? (name ? undefined : byPath)
  if (!match) fail(`No project named "${wanted}". Try: harbor list`)
  return match as Project
}

const HELP = `harbor — local development platform

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
  harbor services [name]           service instances, all or for one project
  harbor start [name] [service]    start a project's services
  harbor stop [name] [service]     stop them
  harbor logs [--lines N]          recent output from everything
  harbor tld [name]                show or change the local TLD
  harbor restart nginx|dns         restart a piece of the plumbing

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

void main().catch((err: Error) => {
  console.error(err.message)
  process.exit(1)
})

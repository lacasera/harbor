import { existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import type {
  LogSource,
  ProjectType,
  ProjectProcessSpec,
  RuntimeRef
} from '../../../shared/index.js'

/**
 * Anything that binds a port: Express, Nest, Vite dev server, Nitro. Served
 * through nginx as a reverse proxy to the allocated port.
 */
export class NodeServerProjectType implements ProjectType {
  readonly id = 'node-server'
  readonly displayName = 'Node server'
  readonly priority = 80
  readonly serveModel = 'reverse-proxy' as const
  readonly defaultPort = 3000

  async detect(dir: string): Promise<boolean> {
    const pkgPath = join(dir, 'package.json')
    if (!existsSync(pkgPath)) return false
    try {
      const pkg = JSON.parse(await readFile(pkgPath, 'utf8')) as {
        scripts?: Record<string, string>
      }
      const scripts = pkg.scripts ?? {}
      return Boolean(scripts.dev ?? scripts.start ?? scripts.serve)
    } catch {
      return false
    }
  }

  async resolveRuntime(dir: string): Promise<RuntimeRef> {
    // Lockfile is the strongest signal for which package runner to use.
    if (existsSync(join(dir, 'bun.lockb')) || existsSync(join(dir, 'bun.lock'))) {
      return { runtime: 'bun', version: '' }
    }
    if (existsSync(join(dir, 'deno.json')) || existsSync(join(dir, 'deno.jsonc'))) {
      return { runtime: 'deno', version: '' }
    }
    return { runtime: 'node', version: '' }
  }

  async startCommand(dir: string): Promise<string | null> {
    const pkgPath = join(dir, 'package.json')
    if (!existsSync(pkgPath)) return null
    try {
      const pkg = JSON.parse(await readFile(pkgPath, 'utf8')) as {
        scripts?: Record<string, string>
      }
      const scripts = pkg.scripts ?? {}
      const script = scripts.dev ? 'dev' : scripts.start ? 'start' : scripts.serve ? 'serve' : null
      if (!script) return null
      if (existsSync(join(dir, 'bun.lockb')) || existsSync(join(dir, 'bun.lock'))) {
        return `bun run ${script}`
      }
      if (existsSync(join(dir, 'pnpm-lock.yaml'))) return `pnpm run ${script}`
      if (existsSync(join(dir, 'yarn.lock'))) return `yarn ${script}`
      return `npm run ${script}`
    } catch {
      return null
    }
  }
  /**
   * A managed dev server's stdout already reaches the aggregator through
   * ProcessManager. This covers apps that also write files — pino, winston and
   * friends default to ./logs.
   */
  logSources(dir: string): LogSource[] {
    return [{ kind: 'dir', path: join(dir, 'logs'), match: '\\.(log|ndjson)$', label: 'app' }]
  }

  /**
   * The dev server itself is the project's start command, not a companion.
   * These are the extra long-running scripts apps conventionally define.
   */
  async processes(dir: string): Promise<ProjectProcessSpec[]> {
    const pkgPath = join(dir, 'package.json')
    if (!existsSync(pkgPath)) return []

    let scripts: Record<string, string> = {}
    try {
      scripts = (JSON.parse(await readFile(pkgPath, 'utf8')) as { scripts?: Record<string, string> })
        .scripts ?? {}
    } catch {
      return []
    }

    const runner = existsSync(join(dir, 'bun.lockb')) || existsSync(join(dir, 'bun.lock'))
      ? 'bun run'
      : existsSync(join(dir, 'pnpm-lock.yaml'))
        ? 'pnpm run'
        : existsSync(join(dir, 'yarn.lock'))
          ? 'yarn'
          : 'npm run'

    return (['worker', 'queue', 'scheduler', 'watch'] as const)
      .filter((name) => scripts[name])
      .map((name) => ({
        id: name,
        label: name[0]!.toUpperCase() + name.slice(1),
        description: `package.json script "${name}"`,
        command: `${runner} ${name}`,
        runtime: 'node' as const,
        autoStart: false,
        restart: 'on-failure' as const
      }))
  }

}

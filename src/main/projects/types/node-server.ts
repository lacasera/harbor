import { existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { ProjectType, RuntimeRef } from '../../../shared/index.js'

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
}

import { existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { LogSource } from '../../../shared/logs.js'
import type {
  NginxRewriteRule,
  PhpFrameworkDriver,
  ProjectProcessSpec
} from '../../../shared/project.js'
import { readProjectEnv } from '../env-file.js'

/** composer.json's combined require map, or empty when unreadable. */
export async function readComposer(dir: string): Promise<Record<string, string>> {
  const path = join(dir, 'composer.json')
  if (!existsSync(path)) return {}
  try {
    const json = JSON.parse(await readFile(path, 'utf8')) as {
      require?: Record<string, string>
      'require-dev'?: Record<string, string>
    }
    return { ...json.require, ...json['require-dev'] }
  } catch {
    return {}
  }
}

export async function hasScript(dir: string, name: string): Promise<boolean> {
  const path = join(dir, 'package.json')
  if (!existsSync(path)) return false
  try {
    const json = JSON.parse(await readFile(path, 'utf8')) as { scripts?: Record<string, string> }
    return Boolean(json.scripts?.[name])
  } catch {
    return false
  }
}

export class LaravelDriver implements PhpFrameworkDriver {
  readonly id = 'laravel'
  readonly displayName = 'Laravel'
  readonly priority = 100

  /** `artisan` is what separates Laravel from Symfony — both have public/index.php. */
  async detect(dir: string): Promise<boolean> {
    return existsSync(join(dir, 'artisan')) && existsSync(join(dir, 'public', 'index.php'))
  }

  docroot(): string {
    return 'public'
  }

  frontController(): string {
    return 'index.php'
  }

  rewrites(): NginxRewriteRule[] {
    return [{ location: '/', directives: ['try_files $uri $uri/ /index.php?$query_string;'] }]
  }

  async isolatedPhpVersion(dir: string): Promise<string | null> {
    const composer = join(dir, 'composer.json')
    if (!existsSync(composer)) return null
    try {
      const json = JSON.parse(await readFile(composer, 'utf8')) as {
        require?: Record<string, string>
      }
      return json.require?.php?.match(/(\d+\.\d+)/)?.[1] ?? null
    } catch {
      return null
    }
  }

  /** Laravel's single and daily channels both live here. */
  logSources(dir: string): LogSource[] {
    return [{ kind: 'dir', path: join(dir, 'storage', 'logs'), match: '\\.log$', label: 'laravel' }]
  }
  /**
   * What a Laravel app needs running beside being served.
   *
   * Every one of these is detected, never assumed: a queue worker is pointless
   * on QUEUE_CONNECTION=sync, Horizon replaces `queue:work` rather than
   * joining it, and Vite only exists if the app has a frontend build. Offering
   * processes an app cannot use is how a panel of toggles becomes noise.
   */
  async processes(dir: string): Promise<ProjectProcessSpec[]> {
    const specs: ProjectProcessSpec[] = []
    const composer = await readComposer(dir)
    const env = await readProjectEnv(dir)
    const value = (key: string): string =>
      env.vars.find((v) => v.key === key)?.value?.toLowerCase() ?? ''

    const has = (pkg: string): boolean => Object.keys(composer).some((k) => k === pkg)

    // Horizon supersedes queue:work — running both means two things competing
    // for the same jobs.
    if (has('laravel/horizon')) {
      specs.push({
        id: 'horizon',
        label: 'Horizon',
        description: 'Queue supervisor and dashboard',
        command: 'php artisan horizon',
        runtime: 'php',
        autoStart: true,
        restart: 'on-failure'
      })
    } else {
      const connection = value('QUEUE_CONNECTION')
      // `sync` runs jobs inline; a worker would sit idle forever.
      if (connection && connection !== 'sync') {
        specs.push({
          id: 'queue',
          label: 'Queue worker',
          description: `Processes jobs on the ${connection} connection`,
          command: 'php artisan queue:listen --tries=1',
          runtime: 'php',
          autoStart: true,
          restart: 'on-failure'
        })
      }
    }

    if (existsSync(join(dir, 'routes', 'console.php')) || existsSync(join(dir, 'app', 'Console', 'Kernel.php'))) {
      specs.push({
        id: 'scheduler',
        label: 'Scheduler',
        description: 'Runs due scheduled tasks every minute',
        command: 'php artisan schedule:work',
        runtime: 'php',
        autoStart: false,
        restart: 'on-failure'
      })
    }

    if (has('laravel/reverb')) {
      specs.push({
        id: 'reverb',
        label: 'Reverb',
        description: 'WebSocket server for broadcasting',
        command: 'php artisan reverb:start',
        runtime: 'php',
        autoStart: false,
        restart: 'on-failure'
      })
    }

    const vite = ['vite.config.js', 'vite.config.ts', 'vite.config.mjs'].some((f) =>
      existsSync(join(dir, f))
    )
    if (vite && (await hasScript(dir, 'dev'))) {
      specs.push({
        id: 'vite',
        label: 'Vite',
        description: 'Frontend dev server with hot reload',
        command: 'npm run dev',
        runtime: 'node',
        // On by default: without it a Vite-built app serves stale or no assets.
        autoStart: true,
        restart: 'never'
      })
    }

    return specs
  }

}

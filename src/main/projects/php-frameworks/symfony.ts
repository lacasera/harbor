import { existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { LogSource } from '../../../shared/logs.js'
import type {
  NginxRewriteRule,
  PhpFrameworkDriver,
  ProjectProcessSpec
} from '../../../shared/project.js'
import { hasScript, readComposer } from './laravel.js'

export class SymfonyDriver implements PhpFrameworkDriver {
  readonly id = 'symfony'
  readonly displayName = 'Symfony'
  readonly priority = 90

  async detect(dir: string): Promise<boolean> {
    if (existsSync(join(dir, 'artisan'))) return false // Laravel wins outright.
    if (existsSync(join(dir, 'bin', 'console'))) return true

    const composer = join(dir, 'composer.json')
    if (!existsSync(composer)) return false
    try {
      const json = JSON.parse(await readFile(composer, 'utf8')) as {
        require?: Record<string, string>
      }
      return Object.keys(json.require ?? {}).some((dep) => dep.startsWith('symfony/'))
    } catch {
      return false
    }
  }

  /** Modern Symfony uses public/; legacy 2.x/3.x used web/. */
  docroot(dir: string): string {
    return existsSync(join(dir, 'public')) ? 'public' : 'web'
  }

  frontController(dir: string): string {
    if (existsSync(join(dir, 'public', 'index.php'))) return 'index.php'
    if (existsSync(join(dir, 'web', 'app.php'))) return 'app.php'
    return 'index.php'
  }

  rewrites(): NginxRewriteRule[] {
    return [{ location: '/', directives: ['try_files $uri /index.php$is_args$args;'] }]
  }

  logSources(dir: string): LogSource[] {
    return [{ kind: 'dir', path: join(dir, 'var', 'log'), match: '\\.log$', label: 'symfony' }]
  }
  async processes(dir: string): Promise<ProjectProcessSpec[]> {
    const specs: ProjectProcessSpec[] = []
    const composer = await readComposer(dir)

    if ('symfony/messenger' in composer) {
      specs.push({
        id: 'messenger',
        label: 'Messenger',
        description: 'Consumes queued messages on the async transport',
        command: 'php bin/console messenger:consume async',
        runtime: 'php',
        autoStart: true,
        restart: 'on-failure'
      })
    }

    // Encore and Vite are both common in Symfony; each has its own script.
    for (const [script, label] of [
      ['dev', 'Vite'],
      ['watch', 'Encore watch']
    ] as const) {
      if (await hasScript(dir, script)) {
        specs.push({
          id: script === 'dev' ? 'vite' : 'encore',
          label,
          description: 'Frontend asset build',
          command: `npm run ${script}`,
          runtime: 'node',
          autoStart: false,
          restart: 'never'
        })
        break
      }
    }

    return specs
  }

}

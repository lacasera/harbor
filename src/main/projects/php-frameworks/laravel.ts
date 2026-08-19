import { existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { LogSource } from '../../../shared/logs.js'
import type { NginxRewriteRule, PhpFrameworkDriver } from '../../../shared/project.js'

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
}

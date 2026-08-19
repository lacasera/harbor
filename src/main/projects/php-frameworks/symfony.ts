import { existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { NginxRewriteRule, PhpFrameworkDriver } from '../../../shared/project.js'

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
}

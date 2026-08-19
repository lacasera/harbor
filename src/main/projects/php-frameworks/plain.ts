import { existsSync } from 'node:fs'
import { join } from 'node:path'
import type { NginxRewriteRule, PhpFrameworkDriver } from '../../../shared/project.js'

/** Last resort. Always matches, so it must stay lowest priority. */
export class PlainPhpDriver implements PhpFrameworkDriver {
  readonly id = 'plain'
  readonly displayName = 'Plain PHP'
  readonly priority = 0

  async detect(): Promise<boolean> {
    return true
  }

  docroot(dir: string): string {
    return existsSync(join(dir, 'public', 'index.php')) ? 'public' : ''
  }

  frontController(): string {
    return 'index.php'
  }

  rewrites(): NginxRewriteRule[] {
    return [{ location: '/', directives: ['try_files $uri $uri/ /index.php?$query_string;'] }]
  }
}

import { existsSync } from 'node:fs'
import { join } from 'node:path'
import type { LogSource } from '../../../shared/logs.js'
import type { NginxRewriteRule, PhpFrameworkDriver } from '../../../shared/project.js'

export class WordPressDriver implements PhpFrameworkDriver {
  readonly id = 'wordpress'
  readonly displayName = 'WordPress'
  readonly priority = 80

  async detect(dir: string): Promise<boolean> {
    return (
      existsSync(join(dir, 'wp-config.php')) ||
      existsSync(join(dir, 'wp-config-sample.php')) ||
      existsSync(join(dir, 'wp-load.php'))
    )
  }

  /** Bedrock-style installs move WP under web/; classic installs serve the root. */
  docroot(dir: string): string {
    return existsSync(join(dir, 'web', 'wp-config.php')) ? 'web' : ''
  }

  frontController(): string {
    return 'index.php'
  }

  rewrites(): NginxRewriteRule[] {
    return [
      { location: '/', directives: ['try_files $uri $uri/ /index.php?$args;'] },
      {
        location: '~* \\.(js|css|png|jpg|jpeg|gif|ico|svg|woff2?)$',
        directives: ['expires max;', 'log_not_found off;', 'access_log off;']
      }
    ]
  }

  /** Only written when WP_DEBUG_LOG is on, so it may never appear. */
  logSources(dir: string): LogSource[] {
    return [
      { kind: 'file', path: join(dir, 'wp-content', 'debug.log'), label: 'wp-debug' }
    ]
  }
}

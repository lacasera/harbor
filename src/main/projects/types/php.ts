import { existsSync } from 'node:fs'
import { join } from 'node:path'
import type { LogSource, ProjectType, RuntimeRef } from '../../../shared/index.js'
import type { PhpRuntime } from '../../runtimes/php.js'

export class PhpProjectType implements ProjectType {
  readonly id = 'php'
  readonly displayName = 'PHP'
  readonly priority = 100
  readonly serveModel = 'fpm' as const

  constructor(private readonly php: PhpRuntime) {}

  async detect(dir: string): Promise<boolean> {
    return (
      existsSync(join(dir, 'composer.json')) ||
      existsSync(join(dir, 'artisan')) ||
      existsSync(join(dir, 'wp-config.php')) ||
      existsSync(join(dir, 'index.php')) ||
      existsSync(join(dir, 'public', 'index.php'))
    )
  }

  async resolveRuntime(dir: string): Promise<RuntimeRef | null> {
    const version = (await this.php.activeVersion(dir)) ?? (await this.php.installedVersions())[0]
    return version ? { runtime: 'php', version } : null
  }

  /** Nothing to spawn — nginx talks straight to the FPM pool. */
  async startCommand(): Promise<string | null> {
    return null
  }
  /**
   * Deliberately empty: where a PHP app logs depends on its framework, and the
   * PhpFrameworkDriver is the thing that knows. ProjectManager merges the two.
   */
  logSources(): LogSource[] {
    return []
  }

}

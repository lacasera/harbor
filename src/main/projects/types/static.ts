import { existsSync } from 'node:fs'
import { join } from 'node:path'
import type { ProjectType } from '../../../shared/index.js'

/** Lowest priority: everything else falls through to plain file serving. */
export class StaticProjectType implements ProjectType {
  readonly id = 'static'
  readonly displayName = 'Static site'
  readonly priority = 0
  readonly serveModel = 'static' as const

  async detect(dir: string): Promise<boolean> {
    return existsSync(dir)
  }

  async resolveRuntime(): Promise<null> {
    return null
  }

  async startCommand(): Promise<string | null> {
    return null
  }

  /** Prefer a built output dir when one exists. */
  docroot(dir: string): string {
    for (const candidate of ['dist', 'build', 'public', '_site']) {
      if (existsSync(join(dir, candidate))) return candidate
    }
    return ''
  }
}

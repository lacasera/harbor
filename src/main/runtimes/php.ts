import { existsSync } from 'node:fs'
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { RuntimeDriver } from '../../shared/runtime.js'
import type { NativeBackend } from '../backends/native-backend.js'

const SUPPORTED = ['8.4', '8.3', '8.2', '8.1']

/**
 * PHP is the one runtime we do NOT manage tarballs for — building PHP from
 * source is a rabbit hole, and Homebrew's php@x.y formulas are well maintained.
 * Prefer shelling out to well-tested tools over reimplementing them.
 */
export class PhpRuntime implements RuntimeDriver {
  readonly id = 'php'
  readonly displayName = 'PHP'
  readonly versionFiles = ['.php-version']

  constructor(private readonly native: NativeBackend) {}

  async availableVersions(): Promise<string[]> {
    return SUPPORTED
  }

  async installedVersions(): Promise<string[]> {
    return SUPPORTED.filter((v) => existsSync(this.resolveBinary(v)))
  }

  resolveBinary(version: string): string {
    const prefix = this.native.brewPrefix() ?? '/opt/homebrew'
    return join(prefix, 'opt', `php@${version}`, 'bin', 'php')
  }

  /** FPM pool socket for a version — what the fastcgi vhost points at. */
  fpmSocket(version: string): string {
    const prefix = this.native.brewPrefix() ?? '/opt/homebrew'
    return join(prefix, 'var', 'run', `php${version.replace('.', '')}-fpm.sock`)
  }

  async install(version: string): Promise<void> {
    await this.native.brewInstall(`php@${version}`)
  }

  async uninstall(version: string): Promise<void> {
    throw new Error(`Uninstall php@${version} with Homebrew: brew uninstall php@${version}`)
  }

  async pin(projectPath: string, version: string): Promise<void> {
    await writeFile(join(projectPath, '.php-version'), `${version}\n`, 'utf8')
  }

  async activeVersion(projectPath: string): Promise<string | null> {
    const path = join(projectPath, '.php-version')
    if (existsSync(path)) {
      const raw = (await readFile(path, 'utf8')).trim()
      if (raw) return raw
    }
    // composer.json's platform/require constraint is the next best signal.
    const composer = join(projectPath, 'composer.json')
    if (existsSync(composer)) {
      try {
        const json = JSON.parse(await readFile(composer, 'utf8')) as {
          require?: Record<string, string>
        }
        const constraint = json.require?.php
        const match = constraint?.match(/(\d+\.\d+)/)
        if (match?.[1]) return match[1]
      } catch {
        /* malformed composer.json is the user's problem, not a crash */
      }
    }
    return null
  }
}

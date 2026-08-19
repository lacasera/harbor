import { existsSync, readdirSync } from 'node:fs'
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { RuntimeDriver } from '../../shared/runtime.js'
import type { NativeBackend } from '../backends/native-backend.js'
import { paths } from '../core/paths.js'

/** Offered for installation. What is *installed* is discovered, not listed. */
const INSTALLABLE = ['8.5', '8.4', '8.3', '8.2', '8.1']

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
    return INSTALLABLE
  }

  /**
   * Discovered from the Homebrew prefix rather than filtered from a hardcoded
   * list: a list goes stale the moment a new PHP is released, and reports a
   * version the user actually has as missing.
   */
  async installedVersions(): Promise<string[]> {
    const prefix = this.native.brewPrefix()
    if (!prefix) return []
    const optDir = join(prefix, 'opt')
    if (!existsSync(optDir)) return []

    const found = new Set<string>()
    for (const entry of readdirSync(optDir)) {
      const match = /^php@(\d+\.\d+)$/.exec(entry)
      if (match?.[1] && existsSync(join(optDir, entry, 'bin', 'php'))) found.add(match[1])
    }
    // The unversioned `php` formula is whatever brew calls current; include it
    // under its real version so it is selectable like any other.
    const plain = join(optDir, 'php', 'bin', 'php')
    if (existsSync(plain)) {
      const version = this.versionOfPrefix()
      if (version) found.add(version)
    }
    return [...found].sort((a, b) => compareMinor(b, a))
  }

  /** Read `X.Y` out of a keg's own directory name, e.g. .../Cellar/php/8.5.4. */
  private versionOfPrefix(): string | null {
    const prefix = this.native.brewPrefix()
    if (!prefix) return null
    const cellar = join(prefix, 'Cellar', 'php')
    if (!existsSync(cellar)) return null
    const versions = readdirSync(cellar)
      .map((v) => /^(\d+\.\d+)/.exec(v)?.[1])
      .filter((v): v is string => Boolean(v))
    return versions.sort((a, b) => compareMinor(b, a))[0] ?? null
  }

  /** The keg for a version, whether it is php@X.Y or the unversioned formula. */
  prefixFor(version: string): string | null {
    const prefix = this.native.brewPrefix()
    if (!prefix) return null
    const versioned = join(prefix, 'opt', `php@${version}`)
    if (existsSync(join(versioned, 'bin', 'php'))) return versioned
    const plain = join(prefix, 'opt', 'php')
    if (existsSync(join(plain, 'bin', 'php')) && this.versionOfPrefix() === version) {
      return plain
    }
    return null
  }

  resolveBinary(version: string): string {
    return join(this.prefixFor(version) ?? join('/opt/homebrew', 'opt', `php@${version}`), 'bin', 'php')
  }

  /** The php-fpm binary for a version, or null when that version is absent. */
  fpmBinary(version: string): string | null {
    const keg = this.prefixFor(version)
    if (!keg) return null
    const binary = join(keg, 'sbin', 'php-fpm')
    return existsSync(binary) ? binary : null
  }

  /**
   * FPM pool socket — a path Harbor owns and creates, not a guess at where
   * Homebrew's own service might put one. Harbor runs its own pool so the
   * user's brew services are untouched.
   */
  fpmSocket(version: string): string {
    return join(paths.run, `php${version.replace('.', '')}-fpm.sock`)
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

/** Compare `X.Y` version keys numerically. */
export function compareMinor(a: string, b: string): number {
  const [am = 0, an = 0] = a.split('.').map(Number)
  const [bm = 0, bn = 0] = b.split('.').map(Number)
  return am - bm || an - bn
}

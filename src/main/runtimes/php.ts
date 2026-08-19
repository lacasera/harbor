import { exec as execCb } from 'node:child_process'
import { promisify } from 'node:util'
import { existsSync, readdirSync, realpathSync } from 'node:fs'
import { readFile, writeFile } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
import type { RuntimeConfigFileSpec, RuntimeDriver, UpdateInfo } from '../../shared/runtime.js'
import type { NativeBackend } from '../backends/native-backend.js'
import { paths } from '../core/paths.js'

const exec = promisify(execCb)

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

  /**
   * The directory PHP scans for extra ini files, on top of Homebrew's own.
   *
   * Harbor's overrides live here rather than in the user's `php.ini`. Editing
   * theirs would mean writing to a file Homebrew owns and replaces on upgrade,
   * and it is the same file their terminal `php` reads — so a change made to
   * fix one site would silently follow every script they run.
   */
  overrideDir(version: string): string {
    return join(paths.php, version, 'conf.d')
  }

  /** Homebrew keeps a version's config outside the keg so upgrades preserve it. */
  systemIni(version: string): string | null {
    const prefix = this.native.brewPrefix()
    if (!prefix) return null
    const ini = join(prefix, 'etc', 'php', version, 'php.ini')
    return existsSync(ini) ? ini : null
  }

  configFiles(version: string): RuntimeConfigFileSpec[] {
    const files: RuntimeConfigFileSpec[] = [
      {
        id: 'overrides',
        label: 'Harbor overrides',
        path: join(this.overrideDir(version), 'harbor.ini'),
        owner: 'harbor',
        scope: `Sites Harbor serves with PHP ${version}. Applied on top of php.ini.`,
        description:
          'Loaded after php.ini and after Homebrew\'s conf.d, so anything set here wins. ' +
          'Saving restarts the PHP-FPM pool.'
      }
    ]

    const ini = this.systemIni(version)
    if (ini) {
      files.push({
        id: 'php.ini',
        label: 'php.ini',
        path: ini,
        owner: 'system',
        scope: `Every PHP ${version} process on this machine, including your terminal.`,
        description:
          'Homebrew owns this file and may replace it when PHP is upgraded. ' +
          'Prefer the overrides above unless you want the change everywhere.'
      })
    }
    return files
  }

  /**
   * The Homebrew formula backing a version, resolved through its alias.
   *
   * `php@8.5` exists as an alias of the unversioned `php` formula while 8.5 is
   * current, so the opt path is present under both names — but `brew outdated`
   * reports only the canonical one. Matching on the alias found nothing and
   * reported a version that was five patches behind as up to date.
   *
   * The Cellar path answers it for free: `opt/php@8.5` resolves to
   * `Cellar/php/8.5.4`, and the directory under Cellar IS the formula name.
   */
  private formulaFor(version: string): { formula: string; installed: string } {
    const prefix = this.native.brewPrefix()
    const fallback = { formula: `php@${version}`, installed: version }
    if (!prefix) return fallback

    for (const name of [`php@${version}`, 'php']) {
      const opt = join(prefix, 'opt', name)
      if (!existsSync(join(opt, 'bin', 'php'))) continue
      try {
        const cellar = realpathSync(opt)
        const installed = basename(cellar)
        const formula = basename(dirname(cellar))
        // The unversioned formula moves between minors; only claim it when it
        // is actually the version being asked about.
        if (!installed.startsWith(`${version}.`)) continue
        return { formula, installed }
      } catch {
        continue
      }
    }
    return fallback
  }

  /**
   * Asked of Homebrew, not of php.net.
   *
   * PHP is not installed side by side under Harbor's own directory — it comes
   * from a formula and is upgraded in place. So the only truthful answer to
   * "is there an update" is the one Homebrew gives, and the only honest way to
   * apply it is `brew upgrade`.
   */
  async checkUpdate(version: string): Promise<UpdateInfo> {
    const brew = this.native.brewPrefix()
    const { formula, installed } = this.formulaFor(version)
    if (!brew) {
      return {
        current: version,
        latest: null,
        available: false,
        major: false,
        action: 'Homebrew is not installed',
        error: 'Homebrew is not installed'
      }
    }

    try {
      const { stdout } = await exec(`${join(brew, 'bin', 'brew')} outdated --json=v2`, {
        maxBuffer: 16 * 1024 * 1024
      })
      const parsed = JSON.parse(stdout) as {
        formulae?: Array<{ name: string; installed_versions: string[]; current_version: string }>
      }
      const entry = parsed.formulae?.find((f) => f.name === formula)
      if (!entry) {
        return {
          current: installed,
          latest: installed,
          available: false,
          major: false,
          action: 'Up to date'
        }
      }
      return {
        current: entry.installed_versions[0] ?? installed,
        latest: entry.current_version,
        // Homebrew keeps a formula on its own line, so an upgrade of php@8.5
        // never becomes 8.6. The unversioned `php` formula can move a minor,
        // which is worth flagging before a one-click upgrade.
        available: true,
        major: formula === 'php' && !entry.current_version.startsWith(`${version}.`),
        action: `brew upgrade ${formula}`
      }
    } catch (err) {
      return {
        current: installed,
        latest: null,
        available: false,
        major: false,
        action: `brew upgrade ${formula}`,
        error: (err as Error).message
      }
    }
  }

  /** In place: this replaces the installed PHP rather than adding one. */
  async update(version: string): Promise<string> {
    const brew = this.native.brewPrefix()
    if (!brew) throw new Error('Homebrew is required to upgrade PHP')
    const { formula } = this.formulaFor(version)
    await exec(`${join(brew, 'bin', 'brew')} upgrade ${formula}`, {
      maxBuffer: 64 * 1024 * 1024
    })
    return (await this.installedVersions())[0] ?? version
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
        // Return the constraint as written, not its first number. Reducing
        // "^8.3" to "8.3" throws away the range, and the resolver then looks
        // for an installed 8.3.x and finds nothing on a machine with 8.4 and
        // 8.5 — which is how the same project reported two different PHP
        // versions in two places.
        const constraint = json.require?.php
        if (constraint) return constraint.trim()
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

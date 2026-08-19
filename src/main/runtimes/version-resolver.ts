import { existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { ResolvedVersion, RuntimeDriver, RuntimeId } from '../../shared/runtime.js'
import type { ConfigStore } from '../core/config-store.js'

/**
 * Resolve the active runtime version for a project, in strict priority order:
 *   1. App override set through the UI (ConfigStore)
 *   2. Version files (.nvmrc / .node-version / .bun-version / .deno-version …)
 *   3. package.json engines / volta / packageManager
 *   4. Runtime default
 * The `source`/`detail` fields are surfaced in the UI so users can see *why*
 * a version was chosen rather than guessing.
 */
export class VersionResolver {
  constructor(private readonly store: ConfigStore) {}

  async resolve(driver: RuntimeDriver, projectPath: string): Promise<ResolvedVersion> {
    const installed = await driver.installedVersions()

    const override = this.store.get().runtimeOverrides[projectPath]?.[driver.id]
    if (override) return this.finish(driver, override, 'app-override', 'set in Harbor', installed)

    const fromFile = await driver.activeVersion(projectPath)
    if (fromFile) {
      const file = driver.versionFiles.find((f) => existsSync(join(projectPath, f)))
      return this.finish(driver, fromFile, 'version-file', file ?? 'version file', installed)
    }

    const manifest = await readManifestVersion(projectPath, driver.id)
    if (manifest) {
      return this.finish(driver, manifest.version, 'manifest', manifest.detail, installed)
    }

    const fallback = this.store.get().runtimeDefaults[driver.id] ?? installed[0] ?? ''
    return this.finish(driver, fallback, 'runtime-default', 'runtime default', installed)
  }

  setOverride(projectPath: string, runtime: RuntimeId, version: string | null): void {
    this.store.update((s) => {
      const forPath = (s.runtimeOverrides[projectPath] ??= {})
      if (version === null) delete forPath[runtime]
      else forPath[runtime] = version
    })
  }

  private finish(
    driver: RuntimeDriver,
    version: string,
    source: ResolvedVersion['source'],
    detail: string,
    installed: string[]
  ): ResolvedVersion {
    // A pin like "20" or ">=20" should match an installed 20.x rather than
    // failing outright — users write ranges, not exact builds.
    const matched = matchVersion(version, installed) ?? version
    const isInstalled = installed.includes(matched)
    return {
      runtime: driver.id,
      version: matched,
      source,
      detail,
      binary: isInstalled ? driver.resolveBinary(matched) : null,
      installed: isInstalled
    }
  }
}

/**
 * Resolve a version spec against what is installed.
 *
 * Prefix matching alone is wrong for the specs people actually write: a
 * project requiring `^8.3` is satisfied by an installed 8.4, but a prefix
 * match reports nothing installed and the site fails to serve. Caret and
 * `>=` are treated as "this or newer, same major"; a bare version still
 * prefers an exact or prefix match first.
 */
export function matchVersion(spec: string, installed: string[]): string | null {
  const trimmed = spec.trim()
  const clean = trimmed.replace(/^[v^~>=<\s]+/, '').trim()
  if (!clean) return null

  // Exact, then prefix (8.3 → 8.3.9), which is what a pinned version means.
  if (installed.includes(clean)) return clean
  const prefixed = installed
    .filter((v) => v === clean || v.startsWith(`${clean}.`))
    .sort(compareSemver)
  if (prefixed.length) return prefixed[prefixed.length - 1] as string

  // Range specs accept anything newer within the same major.
  const isRange = /^[\^~]|^>=/.test(trimmed)
  if (!isRange) return null

  const wantedMajor = Number(clean.split('.')[0])
  const candidates = installed
    .filter((v) => Number(v.split('.')[0]) === wantedMajor && compareSemver(v, clean) >= 0)
    .sort(compareSemver)
  return candidates[candidates.length - 1] ?? null
}

export function compareSemver(a: string, b: string): number {
  const pa = a.split('.').map(Number)
  const pb = b.split('.').map(Number)
  for (let i = 0; i < 3; i++) {
    const diff = (pa[i] ?? 0) - (pb[i] ?? 0)
    if (diff !== 0) return diff
  }
  return 0
}

async function readManifestVersion(
  dir: string,
  runtime: RuntimeId
): Promise<{ version: string; detail: string } | null> {
  const pkgPath = join(dir, 'package.json')
  if (!existsSync(pkgPath)) return null
  try {
    const pkg = JSON.parse(await readFile(pkgPath, 'utf8')) as {
      engines?: Record<string, string>
      volta?: Record<string, string>
      packageManager?: string
    }
    if (pkg.volta?.[runtime]) {
      return { version: pkg.volta[runtime], detail: `package.json#volta.${runtime}` }
    }
    if (pkg.engines?.[runtime]) {
      return { version: pkg.engines[runtime], detail: `package.json#engines.${runtime}` }
    }
    if (runtime === 'bun' && pkg.packageManager?.startsWith('bun@')) {
      return {
        version: pkg.packageManager.slice('bun@'.length),
        detail: 'package.json#packageManager'
      }
    }
    return null
  } catch {
    return null
  }
}

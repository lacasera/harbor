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

export function matchVersion(spec: string, installed: string[]): string | null {
  const clean = spec.replace(/^[v^~>=<\s]+/, '').trim()
  if (!clean) return null
  if (installed.includes(clean)) return clean
  const prefixed = installed
    .filter((v) => v === clean || v.startsWith(`${clean}.`))
    .sort(compareSemver)
  return prefixed[prefixed.length - 1] ?? null
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

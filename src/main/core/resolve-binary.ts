import { accessSync, constants, statSync } from 'node:fs'
import { dirname, isAbsolute, join } from 'node:path'

/**
 * ProcessManager spawns with `shell: false` so Harbor never depends on the
 * user's shell profile. That makes it the caller's job to turn a command like
 * `npm run dev` — which project types read straight out of package.json — into
 * an absolute binary. Without this, spawning fails with a bare ENOENT.
 *
 * `extraDirs` is searched first so a project pinned to a managed runtime uses
 * that toolchain's npm rather than whichever one happens to be on PATH.
 */
export function resolveBinary(
  command: string,
  extraDirs: string[] = [],
  env: NodeJS.ProcessEnv = process.env
): string | null {
  if (command.includes('/')) {
    const absolute = isAbsolute(command) ? command : null
    return absolute && isExecutable(absolute) ? absolute : null
  }

  const pathDirs = (env.PATH ?? '').split(':').filter(Boolean)
  for (const dir of [...extraDirs, ...pathDirs]) {
    const candidate = join(dir, command)
    if (isExecutable(candidate)) return candidate
  }
  return null
}

/** The bin directory of a resolved runtime, for use as an extraDir. */
export function binDirOf(binaryPath: string | null): string[] {
  return binaryPath ? [dirname(binaryPath)] : []
}

function isExecutable(path: string): boolean {
  try {
    if (!statSync(path).isFile()) return false
    accessSync(path, constants.X_OK)
    return true
  } catch {
    return false
  }
}

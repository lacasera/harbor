import type { UpdateInfo } from '../../shared/runtime.js'
import { compareSemver } from './version-resolver.js'

/**
 * The update check for a runtime Harbor installs itself, side by side.
 *
 * Shared by Node, Bun and Deno because for all three the question is the same:
 * is there a release newer than the one on disk. PHP is not like this — it
 * comes from Homebrew and is upgraded in place — which is why this is a helper
 * the drivers opt into rather than behaviour on the base class.
 */
export async function checkManagedUpdate(
  current: string,
  available: () => Promise<string[]>,
  label: string
): Promise<UpdateInfo> {
  let versions: string[]
  try {
    versions = await available()
  } catch (err) {
    // Not "up to date": the check failed, and saying otherwise would be a lie
    // the user has no way to see through.
    return {
      current,
      latest: null,
      available: false,
      major: false,
      action: `Check ${label} releases`,
      error: (err as Error).message
    }
  }

  const newest = versions
    .filter((v) => /^\d+\.\d+\.\d+/.test(v))
    .sort((a, b) => compareSemver(b, a))[0]

  if (!newest || compareSemver(newest, current) <= 0) {
    return { current, latest: current, available: false, major: false, action: 'Up to date' }
  }

  const major = majorOf(newest) !== majorOf(current)
  return {
    current,
    latest: newest,
    available: true,
    major,
    // Side by side, not in place: a project pinned to the old version keeps
    // working, which is the whole point of managing versions per project.
    action: `Install ${label} ${newest} alongside ${current}`
  }
}

function majorOf(version: string): string {
  return version.split('.')[0] ?? ''
}

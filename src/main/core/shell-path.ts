import { exec as execCb } from 'node:child_process'
import { promisify } from 'node:util'
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

const exec = promisify(execCb)

/**
 * Locations worth having on PATH even when the login shell cannot be asked.
 * Ordered by how likely they are to hold the tools Harbor shells out to.
 */
const FALLBACK_DIRS = [
  '/opt/homebrew/bin',
  '/opt/homebrew/sbin',
  '/usr/local/bin',
  '/usr/local/sbin',
  join(homedir(), '.docker/bin'),
  join(homedir(), '.local/bin'),
  '/usr/bin',
  '/bin',
  '/usr/sbin',
  '/sbin'
]

/** Printed by the probe so shell noise before it can be discarded. */
const MARKER = '__HARBOR_PATH__'

/**
 * The PATH the user actually has, not the one macOS gives a GUI app.
 *
 * An app launched from Finder inherits launchd's environment —
 * `/usr/bin:/bin:/usr/sbin:/sbin` — and nothing else. Neither `/usr/local/bin`
 * nor `/opt/homebrew/bin` is on it, so every tool Harbor shells out to is
 * invisible: docker, brew, colima, mkcert. Run from a terminal the app inherits
 * the shell's PATH and all of it works, which is exactly why this only shows up
 * once the app is installed.
 *
 * The login shell is asked first, because a user who put a tool somewhere
 * unusual has already told their shell about it. The static list is the
 * fallback, not the answer.
 */
export async function resolveUserPath(): Promise<{ path: string; source: string }> {
  const current = (process.env.PATH ?? '').split(':').filter(Boolean)
  let fromShell: string[] = []
  let source = 'fallback list'

  const shell = process.env.SHELL
  if (shell && existsSync(shell)) {
    try {
      // `-ilc` so profile files are read. The marker survives whatever a noisy
      // profile prints before it, and the timeout covers a profile that blocks
      // waiting for input — which would otherwise hang startup outright.
      const { stdout } = await exec(`"${shell}" -ilc 'printf "%s" ${MARKER}; printf "%s" "$PATH"'`, {
        timeout: 5000,
        maxBuffer: 1024 * 1024
      })
      const at = stdout.lastIndexOf(MARKER)
      if (at !== -1) {
        fromShell = stdout.slice(at + MARKER.length).trim().split(':').filter(Boolean)
        if (fromShell.length) source = `${shell} -ilc`
      }
    } catch {
      // A shell that fails or times out is not fatal; the fallback list covers
      // every standard location a package manager installs into.
    }
  }

  // The shell's PATH first — it reflects deliberate choices — then whatever we
  // already had, then the known locations. Deduped, and only directories that
  // exist, so the result stays short enough to be worth logging.
  const seen = new Set<string>()
  const merged: string[] = []
  for (const dir of [...fromShell, ...current, ...FALLBACK_DIRS]) {
    if (seen.has(dir) || !existsSync(dir)) continue
    seen.add(dir)
    merged.push(dir)
  }
  return { path: merged.join(':'), source }
}

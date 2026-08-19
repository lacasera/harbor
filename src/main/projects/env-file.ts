import { existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { ProjectEnvFile, ProjectEnvVar } from '../../shared/project.js'

/** Values worth masking until the user asks to see them. */
const SECRET = /(KEY|SECRET|PASSWORD|TOKEN|DSN|CREDENTIAL|SALT|CERT|PRIVATE)/i

/** Filenames worth looking for, most specific first. */
const CANDIDATES = ['.env', '.env.local', '.env.example']

/**
 * Read a project's own environment file.
 *
 * This is deliberately a reader, not a parser with semantics: no interpolation,
 * no `export` handling beyond stripping it, no type coercion. Harbor shows what
 * is on disk so it can be compared against what the services export — guessing
 * at values would make that comparison a lie.
 */
export async function readProjectEnv(dir: string): Promise<ProjectEnvFile> {
  const found = CANDIDATES.map((name) => join(dir, name)).find((p) => existsSync(p))
  if (!found) {
    return { path: join(dir, '.env'), exists: false, vars: [] }
  }

  const raw = await readFile(found, 'utf8').catch(() => '')
  const vars: ProjectEnvVar[] = []

  for (const line of raw.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('#')) continue

    const eq = trimmed.indexOf('=')
    if (eq <= 0) continue

    const key = trimmed.slice(0, eq).replace(/^export\s+/, '').trim()
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) continue

    let value = trimmed.slice(eq + 1).trim()
    // Strip a single matched pair of surrounding quotes, nothing cleverer.
    if (
      (value.startsWith('"') && value.endsWith('"') && value.length > 1) ||
      (value.startsWith("'") && value.endsWith("'") && value.length > 1)
    ) {
      value = value.slice(1, -1)
    }

    vars.push({ key, value, secret: SECRET.test(key) && value.length > 0 })
  }

  return { path: found, exists: true, vars }
}

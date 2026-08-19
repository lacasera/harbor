import { execFile as execFileCb } from 'node:child_process'
import { promisify } from 'node:util'
import { existsSync, mkdirSync, readdirSync, rmSync } from 'node:fs'
import { writeFile, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { Readable } from 'node:stream'
import type { RuntimeDriver } from '../../shared/runtime.js'
import { runtimeDir, paths } from '../core/paths.js'

const execFile = promisify(execFileCb)
const DIST = 'https://nodejs.org/dist'

/**
 * Managed tarballs under ~/.harbor/runtimes/node/<version>. Deliberately
 * isolated in v1: we never read or write the user's nvm/asdf/volta state, and
 * nothing here touches their shell.
 */
export class NodeRuntime implements RuntimeDriver {
  readonly id = 'node'
  readonly displayName = 'Node.js'
  readonly versionFiles = ['.nvmrc', '.node-version']

  private arch = process.arch === 'arm64' ? 'arm64' : 'x64'

  async availableVersions(): Promise<string[]> {
    const res = await fetch(`${DIST}/index.json`, { signal: AbortSignal.timeout(10_000) })
    if (!res.ok) throw new Error(`Node version list failed: HTTP ${res.status}`)
    const index = (await res.json()) as Array<{ version: string; lts: string | false }>
    return index.map((e) => e.version.replace(/^v/, ''))
  }

  async installedVersions(): Promise<string[]> {
    const dir = join(paths.runtimes, this.id)
    if (!existsSync(dir)) return []
    return readdirSync(dir).filter((v) => existsSync(this.resolveBinary(v)))
  }

  resolveBinary(version: string): string {
    return join(runtimeDir(this.id, version), 'bin', 'node')
  }

  async install(version: string): Promise<void> {
    const clean = version.replace(/^v/, '')
    const name = `node-v${clean}-darwin-${this.arch}`
    const target = runtimeDir(this.id, clean)
    mkdirSync(target, { recursive: true })

    const res = await fetch(`${DIST}/v${clean}/${name}.tar.gz`)
    if (!res.ok || !res.body) throw new Error(`Node ${clean} download failed: HTTP ${res.status}`)

    const archive = join(tmpdir(), `${name}.tar.gz`)
    await writeFile(archive, Readable.fromWeb(res.body as Parameters<typeof Readable.fromWeb>[0]))
    // Prefer the system tar over a JS extractor — it handles symlinks and modes
    // correctly, which Node's bin/ layout depends on.
    await execFile('/usr/bin/tar', ['-xzf', archive, '-C', target, '--strip-components=1'])
    rmSync(archive, { force: true })
  }

  async uninstall(version: string): Promise<void> {
    rmSync(runtimeDir(this.id, version), { recursive: true, force: true })
  }

  async pin(projectPath: string, version: string): Promise<void> {
    await writeFile(join(projectPath, '.nvmrc'), `${version}\n`, 'utf8')
  }

  async activeVersion(projectPath: string): Promise<string | null> {
    for (const file of this.versionFiles) {
      const path = join(projectPath, file)
      if (!existsSync(path)) continue
      const raw = (await readFile(path, 'utf8')).trim()
      if (raw) return raw.replace(/^v/, '')
    }
    return null
  }
}

import { execFile as execFileCb } from 'node:child_process'
import { promisify } from 'node:util'
import { existsSync, mkdirSync, readdirSync, rmSync, chmodSync, renameSync } from 'node:fs'
import { writeFile, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { Readable } from 'node:stream'
import type { RuntimeDriver } from '../../shared/runtime.js'
import { runtimeDir, paths } from '../core/paths.js'

const execFile = promisify(execFileCb)

export class BunRuntime implements RuntimeDriver {
  readonly id = 'bun'
  readonly displayName = 'Bun'
  readonly versionFiles = ['.bun-version']

  private target = process.arch === 'arm64' ? 'darwin-aarch64' : 'darwin-x64'

  async availableVersions(): Promise<string[]> {
    const res = await fetch('https://api.github.com/repos/oven-sh/bun/releases?per_page=50', {
      headers: { accept: 'application/vnd.github+json' },
      signal: AbortSignal.timeout(10_000)
    })
    if (!res.ok) throw new Error(`Bun version list failed: HTTP ${res.status}`)
    const releases = (await res.json()) as Array<{ tag_name: string; prerelease: boolean }>
    return releases
      .filter((r) => !r.prerelease && r.tag_name.startsWith('bun-v'))
      .map((r) => r.tag_name.replace(/^bun-v/, ''))
  }

  async installedVersions(): Promise<string[]> {
    const dir = join(paths.runtimes, this.id)
    if (!existsSync(dir)) return []
    return readdirSync(dir).filter((v) => existsSync(this.resolveBinary(v)))
  }

  resolveBinary(version: string): string {
    return join(runtimeDir(this.id, version), 'bun')
  }

  async install(version: string): Promise<void> {
    const clean = version.replace(/^v/, '')
    const dir = runtimeDir(this.id, clean)
    mkdirSync(dir, { recursive: true })

    const url = `https://github.com/oven-sh/bun/releases/download/bun-v${clean}/bun-${this.target}.zip`
    const res = await fetch(url, { redirect: 'follow' })
    if (!res.ok || !res.body) throw new Error(`Bun ${clean} download failed: HTTP ${res.status}`)

    const archive = join(tmpdir(), `bun-${clean}.zip`)
    await writeFile(archive, Readable.fromWeb(res.body as Parameters<typeof Readable.fromWeb>[0]))
    await execFile('/usr/bin/unzip', ['-o', archive, '-d', dir])
    rmSync(archive, { force: true })

    // The archive nests the binary one level deep.
    const nested = join(dir, `bun-${this.target}`, 'bun')
    if (existsSync(nested)) {
      renameSync(nested, this.resolveBinary(clean))
      rmSync(join(dir, `bun-${this.target}`), { recursive: true, force: true })
    }
    chmodSync(this.resolveBinary(clean), 0o755)
  }

  async uninstall(version: string): Promise<void> {
    rmSync(runtimeDir(this.id, version), { recursive: true, force: true })
  }

  async pin(projectPath: string, version: string): Promise<void> {
    await writeFile(join(projectPath, '.bun-version'), `${version}\n`, 'utf8')
  }

  async activeVersion(projectPath: string): Promise<string | null> {
    const path = join(projectPath, '.bun-version')
    if (!existsSync(path)) return null
    return (await readFile(path, 'utf8')).trim() || null
  }
}

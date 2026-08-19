import { execFile as execFileCb } from 'node:child_process'
import { promisify } from 'node:util'
import { existsSync, mkdirSync, readdirSync, rmSync, chmodSync } from 'node:fs'
import { writeFile, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { Readable } from 'node:stream'
import type { RuntimeDriver } from '../../shared/runtime.js'
import { runtimeDir, paths } from '../core/paths.js'

const execFile = promisify(execFileCb)

export class DenoRuntime implements RuntimeDriver {
  readonly id = 'deno'
  readonly displayName = 'Deno'
  readonly versionFiles = ['.deno-version']

  private target = process.arch === 'arm64' ? 'aarch64-apple-darwin' : 'x86_64-apple-darwin'

  async availableVersions(): Promise<string[]> {
    const res = await fetch('https://api.github.com/repos/denoland/deno/releases?per_page=50', {
      headers: { accept: 'application/vnd.github+json' },
      signal: AbortSignal.timeout(10_000)
    })
    if (!res.ok) throw new Error(`Deno version list failed: HTTP ${res.status}`)
    const releases = (await res.json()) as Array<{ tag_name: string; prerelease: boolean }>
    return releases.filter((r) => !r.prerelease).map((r) => r.tag_name.replace(/^v/, ''))
  }

  async installedVersions(): Promise<string[]> {
    const dir = join(paths.runtimes, this.id)
    if (!existsSync(dir)) return []
    return readdirSync(dir).filter((v) => existsSync(this.resolveBinary(v)))
  }

  resolveBinary(version: string): string {
    return join(runtimeDir(this.id, version), 'deno')
  }

  async install(version: string): Promise<void> {
    const clean = version.replace(/^v/, '')
    const dir = runtimeDir(this.id, clean)
    mkdirSync(dir, { recursive: true })

    const url = `https://github.com/denoland/deno/releases/download/v${clean}/deno-${this.target}.zip`
    const res = await fetch(url, { redirect: 'follow' })
    if (!res.ok || !res.body) throw new Error(`Deno ${clean} download failed: HTTP ${res.status}`)

    const archive = join(tmpdir(), `deno-${clean}.zip`)
    await writeFile(archive, Readable.fromWeb(res.body as Parameters<typeof Readable.fromWeb>[0]))
    await execFile('/usr/bin/unzip', ['-o', archive, '-d', dir])
    rmSync(archive, { force: true })
    chmodSync(this.resolveBinary(clean), 0o755)
  }

  async uninstall(version: string): Promise<void> {
    rmSync(runtimeDir(this.id, version), { recursive: true, force: true })
  }

  async pin(projectPath: string, version: string): Promise<void> {
    await writeFile(join(projectPath, '.deno-version'), `${version}\n`, 'utf8')
  }

  async activeVersion(projectPath: string): Promise<string | null> {
    const path = join(projectPath, '.deno-version')
    if (!existsSync(path)) return null
    return (await readFile(path, 'utf8')).trim() || null
  }
}

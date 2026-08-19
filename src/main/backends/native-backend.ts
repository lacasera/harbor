import { exec as execCb } from 'node:child_process'
import { promisify } from 'node:util'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import type { ProcessHandle } from '../../shared/process.js'
import type { ProcessManager } from '../core/process-manager.js'
import type { Backend, BackendStartOptions } from './types.js'

export interface NativeStartOptions extends BackendStartOptions {
  command: string
  args?: string[]
  cwd?: string
  env?: Record<string, string>
}

const exec = promisify(execCb)

const BREW_PREFIXES = ['/opt/homebrew', '/usr/local']

/**
 * Native binaries: PHP, nginx, dnsmasq, MinIO, Meilisearch. No Docker tax, and
 * these are the services users hit constantly.
 */
export class NativeBackend implements Backend<NativeStartOptions> {
  readonly id = 'native' as const

  constructor(private readonly processes: ProcessManager) {}

  async available(): Promise<{ ok: boolean; reason?: string }> {
    const brew = this.brewPrefix()
    if (!brew) return { ok: false, reason: 'Homebrew not found in /opt/homebrew or /usr/local' }
    return { ok: true }
  }

  brewPrefix(): string | null {
    return BREW_PREFIXES.find((p) => existsSync(join(p, 'bin', 'brew'))) ?? null
  }

  /**
   * Absolute path to a brew-installed binary, or null. Both bin and sbin are
   * searched: Homebrew installs daemons like dnsmasq into sbin, and looking
   * only in bin makes them appear uninstalled.
   */
  which(binary: string): string | null {
    for (const prefix of BREW_PREFIXES) {
      for (const dir of ['bin', 'sbin']) {
        const candidate = join(prefix, dir, binary)
        if (existsSync(candidate)) return candidate
      }
    }
    return null
  }

  async brewInstall(formula: string): Promise<void> {
    const brew = this.brewPrefix()
    if (!brew) throw new Error('Homebrew is required to install native services')
    await exec(`${join(brew, 'bin', 'brew')} install ${formula}`, {
      maxBuffer: 32 * 1024 * 1024
    })
  }

  async start(options: NativeStartOptions): Promise<ProcessHandle> {
    return this.processes.spawn({
      owner: { kind: 'service', id: options.serviceId },
      label: options.displayName,
      command: options.command,
      args: options.args ?? [],
      cwd: options.cwd,
      env: options.env
    })
  }

  async stop(serviceId: string): Promise<void> {
    const handle = this.processes.findByOwner('service', serviceId)
    if (handle) await this.processes.stop(handle.id)
  }
}

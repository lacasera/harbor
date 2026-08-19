import { exec as execCb } from 'node:child_process'
import { promisify } from 'node:util'
import { existsSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import type { NativeBackend } from '../backends/native-backend.js'
import type { PrivilegedHelper } from '../core/privileged-helper.js'
import { paths } from '../core/paths.js'

const exec = promisify(execCb)

/**
 * mkcert generates a local CA and per-site certs and handles Keychain trust —
 * we shell out to it rather than reimplementing X.509 handling.
 */
export class TlsManager {
  constructor(
    private readonly native: NativeBackend,
    private readonly privileged: PrivilegedHelper
  ) {}

  private binary(): string | null {
    return this.native.which('mkcert')
  }

  async status(): Promise<{ installed: boolean; caInstalled: boolean }> {
    const bin = this.binary()
    if (!bin) return { installed: false, caInstalled: false }
    const probe = await this.privileged.probe(`${bin} -CAROOT`)
    const caInstalled = probe.ok && existsSync(join(probe.stdout.trim(), 'rootCA.pem'))
    return { installed: true, caInstalled }
  }

  async install(): Promise<void> {
    await this.native.brewInstall('mkcert nss')
  }

  /** Trusting the CA writes to the login Keychain and needs elevation. */
  async installCa(): Promise<void> {
    const bin = this.binary()
    if (!bin) throw new Error('mkcert is not installed')
    await this.privileged.run(`${bin} -install`)
  }

  async certify(domain: string): Promise<{ certFile: string; keyFile: string }> {
    const bin = this.binary()
    if (!bin) throw new Error('mkcert is not installed')
    mkdirSync(paths.certs, { recursive: true })

    const certFile = join(paths.certs, `${domain}.pem`)
    const keyFile = join(paths.certs, `${domain}-key.pem`)
    if (existsSync(certFile) && existsSync(keyFile)) return { certFile, keyFile }

    await exec(`${bin} -cert-file "${certFile}" -key-file "${keyFile}" "${domain}"`)
    return { certFile, keyFile }
  }
}

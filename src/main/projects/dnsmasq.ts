import { existsSync, writeFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import type { NativeBackend } from '../backends/native-backend.js'
import type { PrivilegedHelper } from '../core/privileged-helper.js'
import { paths } from '../core/paths.js'

/**
 * `*.test` → 127.0.0.1. Two halves: a dnsmasq config we own, and a resolver
 * file under /etc that only root can write — hence PrivilegedHelper.
 */
export class DnsmasqManager {
  constructor(
    private readonly native: NativeBackend,
    private readonly privileged: PrivilegedHelper
  ) {}

  private resolverPath(tld: string): string {
    return `/etc/resolver/${tld}`
  }

  async status(tld: string): Promise<{ installed: boolean; configured: boolean }> {
    return {
      installed: this.native.which('dnsmasq') !== null,
      configured: existsSync(this.resolverPath(tld))
    }
  }

  async install(): Promise<void> {
    await this.native.brewInstall('dnsmasq')
  }

  /** Write our dnsmasq fragment, the /etc resolver file, and restart dnsmasq. */
  async configure(tld: string): Promise<void> {
    const prefix = this.native.brewPrefix()
    if (!prefix) throw new Error('Homebrew is required to configure dnsmasq')

    const confDir = join(paths.nginx, '..', 'dnsmasq')
    mkdirSync(confDir, { recursive: true })
    const fragment = join(confDir, `${tld}.conf`)
    writeFileSync(fragment, `address=/.${tld}/127.0.0.1\nport=53\n`, 'utf8')

    // One prompt for the whole sequence — repeated sudo dialogs are miserable.
    await this.privileged.runAll([
      `mkdir -p ${prefix}/etc/dnsmasq.d`,
      `cp '${fragment}' ${prefix}/etc/dnsmasq.d/harbor-${tld}.conf`,
      'mkdir -p /etc/resolver',
      `printf 'nameserver 127.0.0.1\\nport 53\\n' > ${this.resolverPath(tld)}`,
      `${prefix}/bin/brew services restart dnsmasq`
    ])
  }

  async teardown(tld: string): Promise<void> {
    await this.privileged.removeFile(this.resolverPath(tld))
  }
}

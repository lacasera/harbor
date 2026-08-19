import { execFile as execFileCb } from 'node:child_process'
import { promisify } from 'node:util'

const execFile = promisify(execFileCb)

/**
 * What already holds a port, as "command (pid N)", or null when it is free.
 *
 * Both loopback and any-address binds count: a process on 127.0.0.1:8025 wins
 * over a container bound to 0.0.0.0:8025 for local traffic, so ignoring one of
 * them would miss the conflict that actually matters.
 */
export async function portHolder(port: number): Promise<string | null> {
  try {
    const { stdout } = await execFile('/usr/sbin/lsof', [
      '-nP',
      `-iTCP:${port}`,
      '-sTCP:LISTEN',
      '-Fcp'
    ])
    const pid = /^p(\d+)/m.exec(stdout)?.[1]
    const command = /^c(.+)$/m.exec(stdout)?.[1]
    if (!pid || !command) return null
    return `${command} (pid ${pid})`
  } catch {
    // lsof exits non-zero when nothing matches, which is the common case.
    return null
  }
}

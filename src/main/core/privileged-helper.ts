import { exec as execCb, execFile as execFileCb } from 'node:child_process'
import { promisify } from 'node:util'

const exec = promisify(execCb)
const execFile = promisify(execFileCb)

/**
 * Every operation needing root funnels through here: /etc/resolver/<tld>,
 * binding 80/443, editing the system nginx.conf. Nothing else in the codebase
 * calls sudo.
 *
 * Escalation is `osascript … with administrator privileges`, which is what
 * macOS itself uses — the same native authentication dialog, and no
 * dependency. The previous implementation used `sudo-prompt`, which is
 * unmaintained and calls `util.isObject`, removed in Node 23: it throws a
 * TypeError instead of prompting on any modern runtime, and would have broken
 * the moment Electron moved past Node 22.
 *
 * The replacement is still a single choke point, so an SMJobBless helper
 * remains a one-file change.
 */
export class PrivilegedHelper {
  private readonly name = 'Harbor'

  /**
   * Set HARBOR_NO_PROMPT=1 to make escalation fail loudly instead of opening a
   * dialog — headless verification scripts should never hang on one.
   */
  private get interactive(): boolean {
    return process.env.HARBOR_NO_PROMPT !== '1'
  }

  /** Run one command as root, prompting the user. */
  async run(command: string): Promise<string> {
    if (!this.interactive) {
      throw new Error(`refusing to prompt for root (HARBOR_NO_PROMPT=1): ${command}`)
    }

    const script = `do shell script ${quoteForAppleScript(command)} with administrator privileges with prompt ${quoteForAppleScript(
      `${this.name} needs your password to continue.`
    )}`

    try {
      const { stdout } = await execFile('/usr/bin/osascript', ['-e', script], {
        maxBuffer: 16 * 1024 * 1024
      })
      return stdout
    } catch (err) {
      const message = (err as Error).message
      // -128 is the documented "user cancelled" code; say so plainly rather
      // than surfacing an AppleScript error number.
      if (/-128/.test(message)) throw new Error('Authorisation was cancelled')
      throw new Error(message.replace(/^Command failed:[^\n]*\n?/, '').trim() || message)
    }
  }

  /** Batch several commands into one prompt — users hate repeated dialogs. */
  runAll(commands: string[]): Promise<string> {
    return this.run(commands.join(' && '))
  }

  async writeFile(path: string, contents: string): Promise<void> {
    const escaped = contents.replace(/'/g, `'\\''`)
    await this.runAll([`mkdir -p "$(dirname '${path}')"`, `printf '%s' '${escaped}' > '${path}'`])
  }

  async removeFile(path: string): Promise<void> {
    await this.run(`rm -f '${path}'`)
  }

  /**
   * Copy a file we prepared unprivileged into a root-owned location, keeping a
   * one-time backup of whatever was there. Preferred over writeFile for
   * anything large or syntactically fussy: shell-escaping a whole config file
   * into a printf is a good way to corrupt it.
   */
  async installFile(localPath: string, destPath: string, backupPath?: string): Promise<void> {
    const commands: string[] = []
    if (backupPath) {
      // `-n` so the pristine original is never overwritten by a later run.
      commands.push(`cp -n '${destPath}' '${backupPath}' 2>/dev/null || true`)
    }
    commands.push(`cp '${localPath}' '${destPath}'`)
    await this.runAll(commands)
  }

  /** Unprivileged escape hatch for probing before we decide to escalate. */
  async probe(command: string): Promise<{ ok: boolean; stdout: string }> {
    try {
      const { stdout } = await exec(command)
      return { ok: true, stdout }
    } catch {
      return { ok: false, stdout: '' }
    }
  }
}

/** AppleScript string literal: backslashes and quotes need escaping. */
export function quoteForAppleScript(value: string): string {
  return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`
}

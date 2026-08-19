import { exec as execCb } from 'node:child_process'
import { promisify } from 'node:util'
import sudo from 'sudo-prompt'

const exec = promisify(execCb)

/**
 * Every operation needing root funnels through here: /etc/resolver/test,
 * binding 80/443, Keychain trust. Nothing else in the codebase calls sudo.
 *
 * v1 uses sudo-prompt for one-off elevated commands. The replacement is an
 * SMJobBless helper (notarization-friendly); keeping the call sites behind this
 * class is what makes that swap a single-file change.
 */
export class PrivilegedHelper {
  private readonly name = 'Harbor'

  /** Run one command as root, prompting the user. */
  run(command: string): Promise<string> {
    return new Promise((resolve, reject) => {
      sudo.exec(command, { name: this.name }, (err, stdout) => {
        if (err) reject(err)
        else resolve(typeof stdout === 'string' ? stdout : (stdout?.toString() ?? ''))
      })
    })
  }

  /** Batch several commands into one prompt — users hate repeated dialogs. */
  runAll(commands: string[]): Promise<string> {
    return this.run(commands.join(' && '))
  }

  async writeFile(path: string, contents: string): Promise<void> {
    const escaped = contents.replace(/'/g, `'\\''`)
    await this.runAll([
      `mkdir -p "$(dirname '${path}')"`,
      `printf '%s' '${escaped}' > '${path}'`
    ])
  }

  async removeFile(path: string): Promise<void> {
    await this.run(`rm -f '${path}'`)
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

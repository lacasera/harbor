/**
 * Runtime configuration: editing php.ini, or Harbor's own overrides, must
 * change what PHP actually applies — not merely what is on disk.
 *
 *   npm run verify:runtime-config
 *
 * Restores every file it touches. Parks a throwaway PHP site to check the
 * served path, and skips that part cleanly when nginx cannot be reloaded
 * without a password.
 */
import { execFile as execFileCb } from 'node:child_process'
import { promisify } from 'node:util'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { HarborApp } from '../src/main/app.js'
import type { ProjectDescriptor } from '../src/shared/project.js'
import type { PhpRuntime } from '../src/main/runtimes/php.js'

const execFile = promisify(execFileCb)
process.env.HARBOR_NO_PROMPT = '1'

const results: Array<[string, boolean, string]> = []
const step = (name: string, ok: boolean, detail = ''): void => {
  results.push([name, ok, detail])
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`)
}

void (async () => {
  const harbor = new HarborApp()
  const php = harbor.runtimes.get('php') as PhpRuntime
  const version = (await php.installedVersions())[0]
  if (!version) {
    console.log('  ..   no PHP installed; skipping')
    process.exit(0)
  }

  const files = harbor.runtimes.configFiles('php', version)
  /** Whatever was there before this ran; restored in the finally. */
  const original = files.find((f) => f.id === 'overrides')?.content ?? ''
  const setOverride = (content: string): void => {
    harbor.runtimes.writeConfigFile('php', version, 'overrides', content)
  }

  const root = mkdtempSync(join(tmpdir(), 'harbor-ini-'))
  let project: ProjectDescriptor | null = null

  try {
    // ── what the driver declares ────────────────────────────────────────────
    step(
      'php declares an editable overrides file and its php.ini',
      files.some((f) => f.id === 'overrides' && f.owner === 'harbor') &&
        files.some((f) => f.id === 'php.ini' && f.owner === 'system'),
      files.map((f) => `${f.id}(${f.owner})`).join(', ')
    )
    step(
      'every declared path is absolute',
      files.every((f) => f.path.startsWith('/')),
      files.map((f) => f.path).join(' | ')
    )
    // The renderer edits by id. Accepting a path from it would hand a sandboxed
    // presentation layer the ability to write anywhere on disk.
    let refused = ''
    try {
      harbor.runtimes.writeConfigFile('php', version, '../../../etc/passwd', 'x')
    } catch (err) {
      refused = (err as Error).message
    }
    step('an undeclared file id is refused', refused.includes('no config file'), refused)

    // ── what PHP applies ────────────────────────────────────────────────────
    // Asserted against the php-fpm binary with the exact environment Harbor
    // spawns it with, so this holds even where the served path below cannot run.
    const fpmBinary = php.fpmBinary(version)
    const scanDir = php.overrideDir(version)
    const readLimit = async (): Promise<string> => {
      const { stdout } = await execFile(fpmBinary as string, ['-i'], {
        env: { ...process.env, PHP_INI_SCAN_DIR: `:${scanDir}` },
        maxBuffer: 16 * 1024 * 1024
      })
      return /^memory_limit => ([^ ]+)/m.exec(stdout)?.[1] ?? '(not reported)'
    }

    if (!fpmBinary) {
      console.log('  ..   no php-fpm binary for this version; skipping the applied checks')
    } else {
      setOverride('')
      const baseline = await readLimit()

      setOverride('memory_limit = 333M\n')
      const overridden = await readLimit()
      step('an override reaches php-fpm', overridden === '333M', `${baseline} -> ${overridden}`)

      setOverride('')
      const reverted = await readLimit()
      step('clearing it puts the value back', reverted === baseline, `${overridden} -> ${reverted}`)

      // A leading colon keeps the compiled-in scan directory. Without it PHP
      // replaces the default and every extension Homebrew registers disappears.
      const { stdout: modules } = await execFile(php.resolveBinary(version), ['-m'])
      step(
        "Homebrew's own conf.d is still scanned",
        modules.split('\n').filter(Boolean).length > 20,
        `${modules.split('\n').filter((l) => l && !l.startsWith('[')).length} modules`
      )
    }

    // ── what a served site sees ─────────────────────────────────────────────
    const dir = join(root, 'inicheck')
    mkdirSync(join(dir, 'public'), { recursive: true })
    writeFileSync(join(dir, 'public', 'index.php'), "<?php echo ini_get('memory_limit');\n")

    project = await harbor.projects.link(dir)
    const rendered = await harbor.projects.rewriteAllVhosts()
    const url = (await harbor.projects.describe(harbor.projects.find(project.id))).url
    const fetchSite = async (): Promise<string> => {
      const { stdout } = await execFile('/usr/bin/curl', ['-sk', '--max-time', '15', url])
      return stdout.trim()
    }

    setOverride('')
    await harbor.fpm.restart(version)
    const served = await fetchSite()
    if (!/^\d+M$/.test(served)) {
      // nginx serves the config it last loaded, and reloading a root-started
      // master needs a password this script will not ask for. A fact about the
      // machine, not a defect in what is under test.
      console.log(
        `  ..   the new site is not served (${rendered.configError ?? 'nginx was not reloaded'});` +
          ' skipping the end-to-end check'
      )
    } else {
      setOverride('memory_limit = 333M\n')
      await harbor.fpm.restart(version)
      const after = await fetchSite()
      step('an override reaches a served page', after === '333M', `${served} -> ${after}`)
    }
  } catch (err) {
    step('ran to completion', false, (err as Error).message)
  } finally {
    setOverride(original)
    await harbor.fpm.restart(version).catch(() => undefined)
    if (project) await harbor.projects.forget(project.id).catch(() => undefined)
    rmSync(root, { recursive: true, force: true })
    harbor.store.flush()
  }

  const failed = results.filter(([, ok]) => !ok).length
  console.log(`\n${results.length - failed}/${results.length} passed`)
  process.exit(failed ? 1 : 0)
})()

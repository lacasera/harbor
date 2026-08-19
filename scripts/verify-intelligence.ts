/**
 * Phase 5 check: the analyzer against a real Laravel codebase, plus the cache
 * and file-watch behaviour around it.
 *
 *   npm run verify:intelligence [path-to-laravel-app]
 */
import { appendFileSync, existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { HarborApp } from '../src/main/app.js'

const wait = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

const results: Array<[string, boolean, string]> = []
const step = (name: string, ok: boolean, detail = ''): void => {
  results.push([name, ok, detail])
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`)
}

async function main(): Promise<void> {
  const harbor = new HarborApp()
  const target = process.argv[2]

  if (!target || !existsSync(join(target, 'composer.json'))) {
    console.log(`  ..   no PHP app at ${target ?? '(none given)'}; skipping`)
    process.exit(0)
  }
  const laravel = existsSync(join(target, 'artisan'))
  console.log(`  ..   ${laravel ? 'Laravel' : 'Symfony/Doctrine'} app`)

  let projectId: string | null = null
  const sourceDir = laravel ? join(target, 'app', 'Models') : join(target, 'src', 'Entity')
  const scratch = join(sourceDir, '__HarborProbe.php')

  try {
    const project = await harbor.projects.link(target)
    projectId = project.id

    const t0 = Date.now()
    const analysis = await harbor.intelligence.analyze(harbor.projects.find(project.id), true)
    const ms = Date.now() - t0

    const entities = analysis.flatMap((r) => r.entities)
    const relations = analysis.flatMap((r) => r.relations)
    const warnings = analysis.flatMap((r) => r.warnings)
    const known = new Set(entities.map((e) => e.id))

    // Assert that it found something and that what it found is coherent — an
    // arbitrary size threshold just fails on small, correctly-parsed apps.
    step('found models in a real codebase', entities.length > 0, `${entities.length} entities`)
    step('found relations', relations.length > 0, `${relations.length} relations`)
    step('completes quickly', ms < 3000, `${ms}ms`)

    step(
      'no duplicate entities',
      new Set(entities.map((e) => e.name)).size === entities.length,
      `${entities.length} unique`
    )
    step(
      'every relation target is a known model',
      relations.every((r) => known.has(r.to)),
      [...new Set(relations.filter((r) => !known.has(r.to)).map((r) => r.to))].join(', ') || 'all resolved'
    )
    step(
      'every model has columns',
      entities.every((e) => e.fields.length > 0),
      entities.filter((e) => !e.fields.length).map((e) => e.name).join(', ') || 'all populated'
    )
    // Only the ERD analyzer's warnings indicate a parse failure. A dependency
    // analyzer noting "no lockfile, so no transitive deps" is correct
    // reporting, not a defect.
    const parseWarnings = analysis
      .filter((r) => r.analyzerId === 'laravel-eloquent' || r.analyzerId === 'doctrine-erd')
      .flatMap((r) => r.warnings)
    step('no model parse failures', parseWarnings.length === 0, parseWarnings.slice(0, 3).join(' | '))
    const infoWarnings = warnings.filter((w) => !parseWarnings.includes(w))
    if (infoWarnings.length) console.log(`  ..   informational: ${infoWarnings.join(' | ')}`)
    if (laravel) {
      step(
        "Laravel's User model was found",
        entities.some((e) => e.name === 'User'),
        'extends Authenticatable, not Model'
      )
    }

    // Dependency graph from composer.json/lock.
    const deps = analysis.flatMap((r) => r.dependencies.nodes)
    step('composer dependencies parsed', deps.length > 1, `${deps.length} packages`)

    // Cache: a second call must not re-parse.
    const t1 = Date.now()
    await harbor.intelligence.analyze(harbor.projects.find(project.id))
    step('second call served from cache', Date.now() - t1 < 20, `${Date.now() - t1}ms`)

    // File watch: touching a source must invalidate and notify.
    const invalidated = new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => resolve(false), 6000)
      harbor.intelligence.once('invalidated', (id: string) => {
        clearTimeout(timer)
        resolve(id === project.id)
      })
    })
    mkdirSync(sourceDir, { recursive: true })
    writeFileSync(scratch, '<?php\n// Harbor probe\n')
    appendFileSync(scratch, '// touched\n')
    step('a source change invalidates and notifies', await invalidated)
    await wait(200)
  } finally {
    rmSync(scratch, { force: true })
    if (projectId) await harbor.projects.forget(projectId).catch(() => undefined)
    await harbor.shutdown().catch(() => undefined)
  }

  const failed = results.filter(([, ok]) => !ok).length
  console.log(`\n${results.length - failed}/${results.length} steps passed`)
  process.exit(failed ? 1 : 0)
}

void main()

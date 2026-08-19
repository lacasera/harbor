/**
 * Release preflight: reports exactly what is in place for a distributable
 * build and what is missing, rather than letting electron-builder fail deep
 * into a packaging run.
 *
 *   npm run doctor:release
 */
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

// The bundled output lives in node_modules/.cache, so __dirname is not the
// repo. npm scripts always run from the package root.
const root = process.cwd()

type Level = 'ok' | 'warn' | 'missing'
const rows: Array<[Level, string, string]> = []
const add = (level: Level, name: string, detail: string): void => {
  rows.push([level, name, detail])
}

function identities(): string[] {
  try {
    return execFileSync('/usr/bin/security', ['find-identity', '-v', '-p', 'codesigning'], {
      encoding: 'utf8'
    })
      .split('\n')
      .filter((l) => l.includes('"'))
      .map((l) => l.slice(l.indexOf('"') + 1, l.lastIndexOf('"')))
  } catch {
    return []
  }
}

// ── build inputs ──────────────────────────────────────────────────────────
add(
  existsSync(join(root, 'build', 'icon.icns')) ? 'ok' : 'missing',
  'App icon',
  'build/icon.icns — regenerate with `python3 scripts/make-icon.py`'
)
add(
  existsSync(join(root, 'build', 'entitlements.mac.plist')) ? 'ok' : 'missing',
  'Entitlements',
  'build/entitlements.mac.plist'
)
add(
  existsSync(join(root, 'out', 'main', 'index.js')) ? 'ok' : 'warn',
  'Compiled output',
  'out/ — run `npm run build` first'
)

// ── signing ───────────────────────────────────────────────────────────────
const ids = identities()
const devId = ids.find((i) => i.startsWith('Developer ID Application'))
const appleDev = ids.find((i) => i.startsWith('Apple Development'))

if (devId) {
  add('ok', 'Signing identity', devId)
} else if (appleDev) {
  add(
    'warn',
    'Signing identity',
    `only "${appleDev}" — signs for local use, but Gatekeeper blocks it on other machines. ` +
      'Distribution needs a "Developer ID Application" certificate.'
  )
} else {
  add('missing', 'Signing identity', 'no codesigning identity in the keychain')
}

// ── notarization ──────────────────────────────────────────────────────────
let notaryTool = false
try {
  execFileSync('/usr/bin/xcrun', ['--find', 'notarytool'], { stdio: 'ignore' })
  notaryTool = true
} catch {
  /* not installed */
}
add(notaryTool ? 'ok' : 'missing', 'notarytool', 'part of the Xcode command line tools')

const hasNotaryCreds = Boolean(
  (process.env.APPLE_API_KEY && process.env.APPLE_API_KEY_ID && process.env.APPLE_API_ISSUER) ||
    (process.env.APPLE_ID && process.env.APPLE_APP_SPECIFIC_PASSWORD && process.env.APPLE_TEAM_ID)
)
add(
  hasNotaryCreds ? 'ok' : 'missing',
  'Notarization credentials',
  'set APPLE_API_KEY + APPLE_API_KEY_ID + APPLE_API_ISSUER, or APPLE_ID + APPLE_APP_SPECIFIC_PASSWORD + APPLE_TEAM_ID'
)

const builderConfig = readFileSync(join(root, 'electron-builder.yml'), 'utf8')
add(
  /^\s*notarize:/m.test(builderConfig) ? 'ok' : 'warn',
  'Notarization enabled',
  'commented out in electron-builder.yml until a Developer ID certificate exists'
)

// ── auto-update ───────────────────────────────────────────────────────────
add(
  /provider:\s*github/.test(builderConfig) ? 'ok' : 'missing',
  'Update feed configured',
  'publish.provider in electron-builder.yml'
)
add(
  /private:\s*true/.test(builderConfig) ? 'warn' : 'ok',
  'Update feed reachable',
  'the repo is private, so electron-updater needs a GH token at runtime; make it public or host the feed elsewhere'
)

// ── report ────────────────────────────────────────────────────────────────
const mark = { ok: 'ok  ', warn: 'warn', missing: 'MISS' }
console.log('\n  Harbor release preflight\n')
for (const [level, name, detail] of rows) {
  console.log(`  ${mark[level]}  ${name.padEnd(26)} ${detail}`)
}

const missing = rows.filter(([l]) => l === 'missing').length
const warned = rows.filter(([l]) => l === 'warn').length
console.log(
  `\n  ${rows.length - missing - warned} ready · ${warned} needs attention · ${missing} missing`
)
console.log(
  missing || warned
    ? '\n  A signed, notarized build is not possible yet. `npm run package` still\n' +
        '  produces a working unsigned .app for local use.\n'
    : '\n  Ready to build a distributable.\n'
)

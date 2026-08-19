/**
 * Headless sanity check of the pure logic that has no Electron dependency:
 * vhost rendering for all three serve models, env-hint interpolation, version
 * matching, framework detection and Mermaid emission.
 *
 * Run with: npm run smoke
 */
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import assert from 'node:assert/strict'
import {
  NginxManager,
  insertHarborInclude,
  removeHarborInclude
} from '../src/main/projects/nginx-manager.js'
import { createPhpFrameworkRegistry } from '../src/main/projects/php-frameworks/index.js'
import { interpolate, defaultsFor } from '../src/main/services/registry.js'
import { matchVersion } from '../src/main/runtimes/version-resolver.js'
import { tableize } from '../src/main/intelligence/eloquent-erd.js'
import { toErDiagram } from '../src/main/intelligence/mermaid.js'
import { MinioDriver } from '../src/main/services/minio.js'
import type { Project } from '../src/shared/project.js'

const checks: Array<[string, () => void | Promise<void>]> = []
const check = (name: string, fn: () => void | Promise<void>): void => {
  checks.push([name, fn])
}

const baseProject = (over: Partial<Project>): Project => ({
  id: 'p1',
  name: 'api',
  path: '/tmp/api',
  origin: 'linked',
  typeId: 'node-server',
  typeOverridden: false,
  serveModel: 'reverse-proxy',
  frameworkId: null,
  domain: 'api.test',
  secure: false,
  port: 3100,
  startCommandOverride: null,
  runtimeOverride: null,
  createdAt: 0,
  ...over
})

// A stub nginx binary lookup keeps this test off the real filesystem.
const nginx = new NginxManager(
  { which: () => '/opt/homebrew/bin/nginx', brewPrefix: () => '/opt/homebrew' } as never,
  {} as never
)

check('reverse-proxy vhost proxies to the allocated port', () => {
  const conf = nginx.render({ project: baseProject({}), root: '/tmp/api', proxyPort: 3100 })
  assert.match(conf, /server_name api\.test;/)
  assert.match(conf, /proxy_pass http:\/\/127\.0\.0\.1:3100;/)
  assert.match(conf, /proxy_set_header Upgrade \$http_upgrade;/)
})

check('fpm vhost fastcgi_passes to the pool socket', () => {
  const conf = nginx.render({
    project: baseProject({ name: 'blog', domain: 'blog.test', serveModel: 'fpm' }),
    root: '/tmp/blog/public',
    fpmSocket: '/opt/homebrew/var/run/php83-fpm.sock',
    frontController: 'index.php',
    rewrites: [{ location: '/', directives: ['try_files $uri $uri/ /index.php?$query_string;'] }]
  })
  assert.match(conf, /root \/tmp\/blog\/public;/)
  assert.match(conf, /fastcgi_pass unix:\/opt\/homebrew\/var\/run\/php83-fpm\.sock;/)
  assert.match(conf, /try_files \$uri \$uri\/ \/index\.php\?\$query_string;/)
})

check('static vhost serves files directly', () => {
  const conf = nginx.render({
    project: baseProject({ name: 'docs', domain: 'docs.test', serveModel: 'static' }),
    root: '/tmp/docs/dist'
  })
  assert.match(conf, /root \/tmp\/docs\/dist;/)
  assert.doesNotMatch(conf, /proxy_pass|fastcgi_pass/)
})

check('secured vhost listens on 443 with the mkcert pair', () => {
  const conf = nginx.render({
    project: baseProject({ secure: true }),
    root: '/tmp/api',
    proxyPort: 3100,
    cert: { certFile: '/certs/api.test.pem', keyFile: '/certs/api.test-key.pem' }
  })
  assert.match(conf, /listen 443 ssl;/)
  assert.match(conf, /ssl_certificate \/certs\/api\.test\.pem;/)
})

check('framework detection prefers specific over generic', async () => {
  const registry = createPhpFrameworkRegistry()
  const root = mkdtempSync(join(tmpdir(), 'harbor-detect-'))

  const laravel = join(root, 'laravel')
  mkdirSync(join(laravel, 'public'), { recursive: true })
  writeFileSync(join(laravel, 'artisan'), '')
  writeFileSync(join(laravel, 'public', 'index.php'), '')
  assert.equal((await registry.detect(laravel)).id, 'laravel')

  const symfony = join(root, 'symfony')
  mkdirSync(join(symfony, 'bin'), { recursive: true })
  mkdirSync(join(symfony, 'public'), { recursive: true })
  writeFileSync(join(symfony, 'bin', 'console'), '')
  assert.equal((await registry.detect(symfony)).id, 'symfony')

  const wp = join(root, 'wp')
  mkdirSync(wp, { recursive: true })
  writeFileSync(join(wp, 'wp-config.php'), '')
  assert.equal((await registry.detect(wp)).id, 'wordpress')

  const plain = join(root, 'plain')
  mkdirSync(plain, { recursive: true })
  assert.equal((await registry.detect(plain)).id, 'plain')
})

check('env hints interpolate against live config, not schema defaults', () => {
  const minio = new MinioDriver({} as never, {} as never)
  const scope = { ...defaultsFor(minio.configSchema), host: '127.0.0.1', port: 9555 }
  assert.equal(interpolate(minio.envHints.AWS_ENDPOINT as string, scope), 'http://127.0.0.1:9555')
  assert.equal(interpolate(minio.envHints.AWS_ACCESS_KEY_ID as string, scope), 'minioadmin')
})

check('version matching resolves ranges to installed builds', () => {
  assert.equal(matchVersion('20', ['18.20.4', '20.11.1', '20.14.0']), '20.14.0')
  assert.equal(matchVersion('^18.20.4', ['18.20.4', '20.11.1']), '18.20.4')
  assert.equal(matchVersion('22', ['18.20.4']), null)
})

check('tableize follows Laravel pluralization conventions', () => {
  assert.equal(tableize('User'), 'users')
  assert.equal(tableize('Category'), 'categories')
  assert.equal(tableize('OrderItem'), 'order_items')
  assert.equal(tableize('Address'), 'addresses')
})

check('mermaid ERD drops relations to unparsed models', () => {
  const diagram = toErDiagram([
    {
      analyzerId: 'laravel-eloquent',
      generatedAt: 0,
      entities: [
        { id: 'User', name: 'User', table: 'users', fields: [{ name: 'id', type: 'bigint', primary: true }] },
        { id: 'Post', name: 'Post', table: 'posts', fields: [{ name: 'title', type: 'string' }] }
      ],
      relations: [
        { from: 'User', to: 'Post', kind: 'has-many', label: 'posts' },
        { from: 'User', to: 'Ghost', kind: 'has-many', label: 'ghosts' }
      ],
      dependencies: { nodes: [], edges: [] },
      sources: [],
      warnings: []
    }
  ])
  assert.match(diagram, /User \|\|--o\{ Post/)
  assert.doesNotMatch(diagram, /Ghost/)
})

// ── front door: the one file Harbor edits that it does not own ────────────

const INCLUDE = 'include /Users/x/.harbor/nginx/harbor.conf;'
const NGINX_CONF = `worker_processes 1;

events {
    worker_connections 1024;
}

http {
    include mime.types;
    default_type application/octet-stream;
    sendfile on;

    server {
        listen 8080;
        server_name localhost;
    }
}
`

check('include lands inside the top-level http block', () => {
  const out = insertHarborInclude(NGINX_CONF, INCLUDE)
  assert.ok(out, 'expected a modified config')
  const lines = (out as string).split('\n')
  const httpAt = lines.findIndex((l) => /^\s*http\s*\{/.test(l))
  const includeAt = lines.findIndex((l) => l.includes(INCLUDE))
  assert.ok(includeAt > httpAt, 'include must come after http {')

  // It must land in the http block, not inside the nested server block.
  const serverAt = lines.findIndex((l) => /^\s*server\s*\{/.test(l))
  assert.ok(includeAt < serverAt, 'include must precede the nested server block')
})

check('connecting twice is a no-op', () => {
  const once = insertHarborInclude(NGINX_CONF, INCLUDE) as string
  assert.equal(insertHarborInclude(once, INCLUDE), null)
})

check('disconnect restores the original byte for byte', () => {
  const connected = insertHarborInclude(NGINX_CONF, INCLUDE) as string
  const restored = removeHarborInclude(connected, INCLUDE)
  assert.equal(restored, NGINX_CONF)
})

check('disconnecting an unconnected config is a no-op', () => {
  assert.equal(removeHarborInclude(NGINX_CONF, INCLUDE), null)
})

check('a config with no http block is rejected, not corrupted', () => {
  assert.throws(
    () => insertHarborInclude('events {\n  worker_connections 1024;\n}\n', INCLUDE),
    /no top-level http/i
  )
})

const run = async (): Promise<void> => {
  let failed = 0
  for (const [name, fn] of checks) {
    try {
      await fn()
      console.log(`  ok   ${name}`)
    } catch (err) {
      failed++
      console.error(`  FAIL ${name}\n       ${(err as Error).message}`)
    }
  }
  console.log(`\n${checks.length - failed}/${checks.length} passed`)
  if (failed) process.exit(1)
}

void run()

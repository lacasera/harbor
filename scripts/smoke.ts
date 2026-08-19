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
import { interpolate, defaultsFor, validate } from '../src/main/services/registry.js'
import { matchVersion } from '../src/main/runtimes/version-resolver.js'
import { EloquentErdAnalyzer, tableize } from '../src/main/intelligence/eloquent-erd.js'
import { toErDiagram } from '../src/main/intelligence/mermaid.js'
import { resolveBinary } from '../src/main/core/resolve-binary.js'
import { MinioDriver } from '../src/main/services/minio.js'
import type { Project } from '../src/shared/project.js'

const checks: Array<[string, () => void | Promise<void>]> = []
const check = (name: string, fn: () => void | Promise<void>): void => {
  checks.push([name, fn])
}

/**
 * Every non-blank line must be a comment, a block open/close, or a directive
 * ending in ';'. The original tests only regex-matched the whole string, which
 * happily passed on a config whose entire body had been collapsed into one
 * comma-separated line.
 */
const assertWellFormed = (conf: string): void => {
  let depth = 0
  for (const [i, raw] of conf.split('\n').entries()) {
    const line = raw.trim()
    if (!line || line.startsWith('#')) continue
    assert.ok(
      !line.includes(';,') && !/,\s{2,}/.test(line),
      `line ${i + 1} looks comma-joined: ${line.slice(0, 60)}`
    )
    if (line.endsWith('{')) depth++
    else if (line === '}') depth--
    else {
      assert.ok(line.endsWith(';'), `line ${i + 1} is not a directive: ${line.slice(0, 60)}`)
    }
    assert.ok(depth >= 0, `unbalanced braces at line ${i + 1}`)
  }
  assert.equal(depth, 0, 'unbalanced braces in vhost')
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
  serviceIds: [],
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
  assertWellFormed(conf)
  assert.match(conf, /^\s{4}listen 80;$/m)
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
  assertWellFormed(conf)
  assert.match(conf, /root \/tmp\/blog\/public;/)
  assert.match(conf, /fastcgi_pass unix:\/opt\/homebrew\/var\/run\/php83-fpm\.sock;/)
  assert.match(conf, /try_files \$uri \$uri\/ \/index\.php\?\$query_string;/)
})

check('static vhost serves files directly', () => {
  const conf = nginx.render({
    project: baseProject({ name: 'docs', domain: 'docs.test', serveModel: 'static' }),
    root: '/tmp/docs/dist'
  })
  assertWellFormed(conf)
  assert.match(conf, /root \/tmp\/docs\/dist;/)
  assert.doesNotMatch(conf, /proxy_pass|fastcgi_pass/)
})

check('listen ports are configurable for an unprivileged nginx', () => {
  const conf = nginx.render({
    project: baseProject({}),
    root: '/tmp/api',
    proxyPort: 3100,
    httpPort: 8080
  })
  assertWellFormed(conf)
  assert.match(conf, /listen 8080;/)
  assert.doesNotMatch(conf, /listen 80;/)
})

check('secured vhost listens on 443 with the mkcert pair', () => {
  const conf = nginx.render({
    project: baseProject({ secure: true }),
    root: '/tmp/api',
    proxyPort: 3100,
    cert: { certFile: '/certs/api.test.pem', keyFile: '/certs/api.test-key.pem' }
  })
  assertWellFormed(conf)
  assert.match(conf, /listen 443 ssl;/)
  assert.match(conf, /ssl_certificate \/certs\/api\.test\.pem;/)
})

check('a secured site still answers on the HTTP port with a redirect', () => {
  const conf = nginx.render({
    project: baseProject({ secure: true }),
    root: '/tmp/api',
    proxyPort: 3100,
    httpPort: 8081,
    httpsPort: 8443,
    cert: { certFile: '/certs/api.test.pem', keyFile: '/certs/api.test-key.pem' }
  })
  assertWellFormed(conf)
  // Two server blocks: the redirect and the TLS site. Without the first,
  // http://<site> falls through to whichever vhost is that port's default.
  assert.equal(conf.match(/^server \{$/gm)?.length, 2)
  assert.match(conf, /listen 8081;/)
  assert.match(conf, /return 301 https:\/\/\$host:8443\$request_uri;/)
  assert.match(conf, /listen 8443 ssl;/)
})

check('the redirect omits the port when https is on 443', () => {
  const conf = nginx.render({
    project: baseProject({ secure: true }),
    root: '/tmp/api',
    proxyPort: 3100,
    cert: { certFile: '/c.pem', keyFile: '/k.pem' }
  })
  assertWellFormed(conf)
  assert.match(conf, /return 301 https:\/\/\$host\$request_uri;/)
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

check('config is validated against the driver schema', () => {
  const minio = new MinioDriver({} as never, {} as never)
  const good = defaultsFor(minio.configSchema)
  assert.deepEqual(validate(minio.configSchema, good), [])

  // Out-of-range port: the schema's own minimum is the rule, not a hand-written check.
  const badPort = validate(minio.configSchema, { ...good, port: 80 })
  assert.equal(badPort.length, 1)
  assert.equal(badPort[0]?.field, 'port')

  // A missing required field is reported against that field, not the object.
  const { rootUser: _omitted, ...missing } = good
  const required = validate(minio.configSchema, missing)
  assert.ok(required.some((e) => e.field === 'rootUser' && e.message === 'is required'))

  // Too-short password trips minLength.
  const short = validate(minio.configSchema, { ...good, rootPassword: 'abc' })
  assert.ok(short.some((e) => e.field === 'rootPassword'))
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

check('the Eloquent analyzer handles the shapes real Laravel apps use', async () => {
  const root = mkdtempSync(join(tmpdir(), 'harbor-eloquent-'))
  mkdirSync(join(root, 'app', 'Models'), { recursive: true })
  mkdirSync(join(root, 'database', 'migrations'), { recursive: true })

  // Laravel's own User extends Authenticatable, not Model.
  writeFileSync(
    join(root, 'app', 'Models', 'User.php'),
    `<?php
namespace App\\Models;
use Illuminate\\Foundation\\Auth\\User as Authenticatable;
class User extends Authenticatable {
  public function posts() { return $this->hasMany(Post::class); }
  public function avatar() { return $this->morphOne(Asset::class, 'assetable'); }
}
`
  )
  writeFileSync(
    join(root, 'app', 'Models', 'Post.php'),
    `<?php
namespace App\\Models;
use Illuminate\\Database\\Eloquent\\Model;
class Post extends Model {
  public function author() { return $this->belongsTo(User::class); }
}
`
  )
  // A polymorphic model: morphTo has no static target and must not warn.
  writeFileSync(
    join(root, 'app', 'Models', 'Asset.php'),
    `<?php
namespace App\\Models;
use Illuminate\\Database\\Eloquent\\Model;
class Asset extends Model {
  public function assetable() { return $this->morphTo(); }
}
`
  )
  // Modern migrations use a typed closure.
  writeFileSync(
    join(root, 'database', 'migrations', '2025_01_01_000000_create_users_table.php'),
    `<?php
return new class () extends Migration {
    public function up(): void
    {
        Schema::create('users', function (Blueprint $table): void {
            $table->bigIncrements('id');
            $table->string('email')->unique();
            $table->string('name')->nullable();
            $table->timestamps();
        });
    }
};
`
  )

  const result = await new EloquentErdAnalyzer().analyze(root)
  const names = result.entities.map((e) => e.name).sort()

  assert.deepEqual(names, ['Asset', 'Post', 'User'], 'User must be found despite Authenticatable')
  assert.equal(new Set(names).size, names.length, 'entities must not be duplicated')

  const user = result.entities.find((e) => e.name === 'User')
  assert.ok(user, 'User entity')
  // Proves the typed-closure migration was parsed.
  assert.deepEqual(
    user?.fields.map((f) => f.name),
    ['id', 'email', 'name', 'created_at', 'updated_at']
  )
  assert.equal(user?.fields[0]?.primary, true, 'bigIncrements is the primary key')

  // morphTo is polymorphic by design, not a parse failure. (Warnings about
  // Post/Asset having no migration are correct — this fixture only defines a
  // users table — so assert on the morphTo case specifically.)
  assert.ok(
    !result.warnings.some((w) => w.includes('assetable')),
    `morphTo must not warn, got: ${result.warnings.join(' | ')}`
  )
  assert.ok(!result.relations.some((r) => r.to === 'Asset' && r.kind === 'belongs-to'))

  const known = new Set(result.entities.map((e) => e.id))
  assert.ok(result.relations.every((r) => known.has(r.to)), 'no dangling relation targets')
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

check('start commands resolve to absolute binaries', () => {
  // ProcessManager spawns with shell:false, so a bare command must be resolved
  // or the spawn fails with ENOENT.
  const found = resolveBinary('sh', [], { PATH: '/usr/bin:/bin' })
  assert.equal(found, '/bin/sh')

  assert.equal(resolveBinary('definitely-not-a-real-binary', [], { PATH: '/bin' }), null)

  // extraDirs win, so a pinned runtime's toolchain beats whatever is on PATH.
  assert.equal(resolveBinary('sh', ['/bin'], { PATH: '/usr/bin' }), '/bin/sh')
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

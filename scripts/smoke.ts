/**
 * Headless sanity check of the pure logic that has no Electron dependency:
 * vhost rendering for all three serve models, env-hint interpolation, version
 * matching, framework detection and Mermaid emission.
 *
 * Run with: npm run smoke
 */
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import assert from 'node:assert/strict'
import {
  NginxManager,
  insertHarborInclude,
  removeHarborInclude,
  setWorkerUser,
  removeWorkerUser
} from '../src/main/projects/nginx-manager.js'
import { createPhpFrameworkRegistry } from '../src/main/projects/php-frameworks/index.js'
import { interpolate, defaultsFor, validate } from '../src/main/services/registry.js'
import { matchVersion } from '../src/main/runtimes/version-resolver.js'
import { EloquentErdAnalyzer, tableize } from '../src/main/intelligence/eloquent-erd.js'
import { parseEntity, snakeCase } from '../src/main/intelligence/doctrine-erd.js'
import { LaravelDriver } from '../src/main/projects/php-frameworks/laravel.js'
import { toErDiagram } from '../src/main/intelligence/mermaid.js'
import { resolveBinary } from '../src/main/core/resolve-binary.js'
import { readProjectEnv } from '../src/main/projects/env-file.js'
import { streamLabel } from '../src/main/core/log-aggregator.js'
import { quoteForAppleScript } from '../src/main/core/privileged-helper.js'
import { adviseTld } from '../src/shared/tld.js'
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
  processOverrides: {},
  customProcesses: [],
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

check('an unmatched host gets a catch-all, not another project', () => {
  // Without a default server, nginx serves whichever vhost loaded first for
  // that port — so a site with a stale or missing vhost silently returns a
  // different project's content, which looks like nothing is wrong at all.
  const dir = mkdtempSync(join(tmpdir(), 'harbor-default-'))
  const original = process.env.HOME
  try {
    nginx.writeDefaultVhost({ httpPort: 80, httpsPort: 443, tld: 'test' })
    const conf = readFileSync(join(homedir(), '.harbor', 'nginx', 'sites', '000-harbor-default.conf'), 'utf8')

    assertWellFormed(conf.replace(/return 404 "[\s\S]*?";/g, 'return 404;'))
    assert.match(conf, /server_name _;/)
    assert.match(conf, /listen 80;/)
    assert.match(conf, /return 404/)
    // Named to sort ahead of every domain, so nginx treats it as the default.
    assert.ok('000-harbor-default.conf' < 'acme.test.conf')
  } finally {
    rmSync(dir, { recursive: true, force: true })
    if (original) process.env.HOME = original
  }
})

check('the catch-all serves TLS only when a certificate exists', () => {
  nginx.writeDefaultVhost({ httpPort: 80, httpsPort: 443, tld: 'test' })
  const withoutCert = readFileSync(
    join(homedir(), '.harbor', 'nginx', 'sites', '000-harbor-default.conf'),
    'utf8'
  )
  // An ssl block with no certificate would stop nginx starting entirely.
  assert.doesNotMatch(withoutCert, /listen 443 ssl/)

  nginx.writeDefaultVhost({
    httpPort: 80,
    httpsPort: 443,
    tld: 'test',
    cert: { certFile: '/c.pem', keyFile: '/k.pem' }
  })
  const withCert = readFileSync(
    join(homedir(), '.harbor', 'nginx', 'sites', '000-harbor-default.conf'),
    'utf8'
  )
  assert.match(withCert, /listen 443 ssl;/)
  assert.match(withCert, /ssl_certificate \/c\.pem;/)
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

  // The case that made one project report two different PHP versions: a
  // caret range is satisfied by a newer minor, and must resolve to the newest
  // installed one rather than to nothing.
  assert.equal(matchVersion('^8.3', ['8.5', '8.4']), '8.5')
  assert.equal(matchVersion('>=8.2', ['8.5', '8.4']), '8.5')
  // A bare version is a pin, not a range: no match means no match.
  assert.equal(matchVersion('8.3', ['8.5', '8.4']), null)
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

check('the Doctrine analyzer reads PHP 8 attribute mapping', () => {
  const src = `<?php
namespace App\\Entity;
use Doctrine\\DBAL\\Types\\Types;
use Doctrine\\ORM\\Mapping as ORM;

#[ORM\\Entity(repositoryClass: PostRepository::class)]
#[ORM\\Table(name: 'symfony_demo_post')]
class Post
{
    #[ORM\\Id]
    #[ORM\\GeneratedValue]
    #[ORM\\Column(type: Types::INTEGER)]
    private ?int $id = null;

    #[ORM\\Column(type: Types::STRING)]
    private ?string $title = null;

    #[ORM\\Column(nullable: true)]
    private \\DateTimeImmutable $publishedAt;

    #[ORM\\ManyToOne(targetEntity: User::class)]
    private ?User $author = null;

    #[ORM\\OneToMany(targetEntity: Comment::class, mappedBy: 'post')]
    private Collection $comments;

    #[ORM\\ManyToMany(targetEntity: Tag::class)]
    private Collection $tags;
}
`
  const parsed = parseEntity('Post', src)
  assert.equal(parsed.table, 'symfony_demo_post')
  assert.deepEqual(
    parsed.fields.map((f) => f.name),
    ['id', 'title', 'published_at']
  )
  assert.equal(parsed.fields[0]?.primary, true)
  assert.equal(parsed.fields[1]?.type, 'string')
  // No explicit type: Doctrine infers from the hint, displayed without its namespace.
  assert.equal(parsed.fields[2]?.type, 'DateTimeImmutable')
  assert.equal(parsed.fields[2]?.nullable, true)

  assert.deepEqual(
    parsed.relations.map((r) => `${r.kind}:${r.to}`),
    ['belongs-to:User', 'has-many:Comment', 'many-to-many:Tag']
  )
  assert.deepEqual(parsed.warnings, [])
})

check('the Doctrine analyzer still reads legacy docblock annotations', () => {
  const src = `<?php
/**
 * @ORM\\Entity()
 * @ORM\\Table(name="legacy_order")
 */
class Order
{
    /**
     * @ORM\\Id
     * @ORM\\Column(type="integer")
     */
    private $id;

    /** @ORM\\Column(name="placed_at", type="datetime", nullable=true) */
    private $placedAt;

    /** @ORM\\ManyToOne(targetEntity="App\\Entity\\Customer") */
    private $customer;
}
`
  const parsed = parseEntity('Order', src)
  assert.equal(parsed.table, 'legacy_order')
  assert.deepEqual(
    parsed.fields.map((f) => `${f.name}:${f.type}`),
    ['id:integer', 'placed_at:datetime']
  )
  assert.equal(parsed.fields[1]?.nullable, true)
  // A fully-qualified target keys on the short name, like the entity list does.
  assert.deepEqual(
    parsed.relations.map((r) => `${r.kind}:${r.to}`),
    ['belongs-to:Customer']
  )
})

check('Doctrine falls back to a conventional table name', () => {
  assert.equal(snakeCase('BlogPost'), 'blog_post')
  const parsed = parseEntity('BlogPost', '<?php\n#[ORM\\Entity]\nclass BlogPost {}\n')
  assert.equal(parsed.table, 'blog_post')
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

check('real public TLDs are flagged before they are adopted', () => {
  // Harbor points a whole suffix at 127.0.0.1; choosing a real one makes every
  // genuine site under it unreachable from the machine.
  assert.equal(adviseTld('test').level, 'ok')
  assert.equal(adviseTld('.test').level, 'ok')
  assert.equal(adviseTld('localhost').level, 'ok')

  // .app and .dev are HSTS-preloaded, which is worse than merely colliding.
  assert.equal(adviseTld('app').level, 'danger')
  assert.match(adviseTld('app').message, /HSTS/)
  assert.equal(adviseTld('dev').level, 'danger')
  assert.equal(adviseTld('local').level, 'danger')

  // Unregistered suffixes work but carry a caveat.
  assert.equal(adviseTld('harbor').level, 'warn')
  assert.equal(adviseTld('').level, 'danger')
  assert.equal(adviseTld('not valid!').level, 'danger')
})

check('log stream labels keep the part that differs', () => {
  // These two must not collapse to the same truncated column.
  assert.equal(streamLabel('nginx', 'acme-commerce.test.access.log'), 'nginx/access')
  assert.equal(streamLabel('nginx', 'acme-commerce.test.error.log'), 'nginx/error')
  assert.equal(streamLabel('laravel', 'laravel.log'), 'laravel/laravel')
  assert.equal(streamLabel('laravel', 'laravel-2026-08-19.log'), 'laravel/laravel-2026-08-19')
  assert.equal(streamLabel(undefined, 'debug.log'), 'debug')
})

check('companion processes are detected, never assumed', async () => {
  const root = mkdtempSync(join(tmpdir(), 'harbor-proc-'))
  mkdirSync(join(root, 'routes'), { recursive: true })
  mkdirSync(join(root, 'public'), { recursive: true })
  writeFileSync(join(root, 'artisan'), '')
  writeFileSync(join(root, 'public', 'index.php'), '')
  writeFileSync(join(root, 'routes', 'console.php'), '')

  const driver = new LaravelDriver()
  const ids = async (): Promise<string[]> => (await driver.processes(root)).map((p) => p.id)

  // A sync queue runs jobs inline; offering a worker would be noise.
  writeFileSync(join(root, '.env'), 'QUEUE_CONNECTION=sync\n')
  writeFileSync(join(root, 'composer.json'), JSON.stringify({ require: {} }))
  assert.deepEqual(await ids(), ['scheduler'])

  // A real connection means a real worker.
  writeFileSync(join(root, '.env'), 'QUEUE_CONNECTION=database\n')
  assert.deepEqual(await ids(), ['queue', 'scheduler'])

  // Horizon supersedes queue:work rather than joining it — running both would
  // put two supervisors on the same jobs.
  writeFileSync(
    join(root, 'composer.json'),
    JSON.stringify({ require: { 'laravel/horizon': '^5.0', 'laravel/reverb': '^1.0' } })
  )
  const withHorizon = await ids()
  assert.ok(withHorizon.includes('horizon'))
  assert.ok(!withHorizon.includes('queue'), 'horizon replaces the plain worker')
  assert.ok(withHorizon.includes('reverb'))

  // Vite only when there is actually a frontend build to run.
  assert.ok(!withHorizon.includes('vite'))
  writeFileSync(join(root, 'vite.config.js'), '')
  writeFileSync(join(root, 'package.json'), JSON.stringify({ scripts: { dev: 'vite' } }))
  assert.ok((await ids()).includes('vite'))

  // Each declares which runtime provides its binary — php for the worker,
  // node for the asset build.
  const specs = await driver.processes(root)
  assert.equal(specs.find((p) => p.id === 'horizon')?.runtime, 'php')
  assert.equal(specs.find((p) => p.id === 'vite')?.runtime, 'node')
})

check('a project .env is read as written, not interpreted', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'harbor-env-'))
  writeFileSync(
    join(dir, '.env'),
    [
      '# a comment',
      '',
      'APP_NAME=Laravel',
      'APP_KEY=base64:abcdef==',
      'export DB_HOST=127.0.0.1',
      'QUOTED="hello world"',
      "SINGLE='single quoted'",
      'EMPTY=',
      'MAIL_PASSWORD=hunter2',
      'not a pair',
      '9INVALID=x',
      'WITH_EQUALS=a=b=c'
    ].join('\n')
  )

  const env = await readProjectEnv(dir)
  assert.equal(env.exists, true)

  const byKey = Object.fromEntries(env.vars.map((v) => [v.key, v.value]))
  assert.equal(byKey.APP_NAME, 'Laravel')
  assert.equal(byKey.DB_HOST, '127.0.0.1', 'export prefix is stripped')
  assert.equal(byKey.QUOTED, 'hello world', 'one matched quote pair is removed')
  assert.equal(byKey.SINGLE, 'single quoted')
  assert.equal(byKey.EMPTY, '')
  assert.equal(byKey.WITH_EQUALS, 'a=b=c', 'only the first = separates')
  assert.ok(!('9INVALID' in byKey), 'invalid identifiers are skipped')
  assert.equal(env.vars.length, 8)

  // Secrets are flagged for masking, but their values are still read.
  const secrets = env.vars.filter((v) => v.secret).map((v) => v.key).sort()
  assert.deepEqual(secrets, ['APP_KEY', 'MAIL_PASSWORD'])
  assert.equal(byKey.MAIL_PASSWORD, 'hunter2')

  // An empty value is not worth masking.
  assert.equal(env.vars.find((v) => v.key === 'EMPTY')?.secret, false)
})

check('a project with no .env reports that rather than failing', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'harbor-noenv-'))
  const env = await readProjectEnv(dir)
  assert.equal(env.exists, false)
  assert.deepEqual(env.vars, [])
  assert.match(env.path, /\.env$/)
})

check('privileged commands are escaped for AppleScript', () => {
  // This string is interpolated into a command that runs as root, so a
  // mis-escaped quote is a command-injection bug, not a formatting nit.
  assert.equal(quoteForAppleScript('echo hi'), '"echo hi"')
  assert.equal(quoteForAppleScript('printf "x"'), '"printf \\"x\\""')
  assert.equal(quoteForAppleScript('a\\b'), '"a\\\\b"')
  // A closing quote must not be able to escape the literal.
  const hostile = 'x" with administrator privileges; rm -rf /; "'
  const quoted = quoteForAppleScript(hostile)
  assert.equal(quoted.match(/(?<!\\)"/g)?.length, 2, 'only the delimiters are unescaped quotes')
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

check('worker user is set so a root master can read parked projects', () => {
  // A root master drops workers to the `user` directive; Homebrew ships it
  // commented out, so they become nobody and cannot read /Users at all.
  const out = setWorkerUser(NGINX_CONF, 'william', 'staff')
  assert.ok(out, 'expected a modified config')
  const lines = (out as string).split('\n')
  const at = lines.findIndex((l) => l.trim() === 'user william staff;')
  assert.ok(at >= 0, 'directive present')

  // It must land in the main context, before `http {`.
  const httpAt = lines.findIndex((l) => /^\s*http\s*\{/.test(l))
  assert.ok(at < httpAt, 'user must precede the http block')
})

check('setting the worker user twice is a no-op', () => {
  const once = setWorkerUser(NGINX_CONF, 'william', 'staff') as string
  assert.equal(setWorkerUser(once, 'william', 'staff'), null)
})

check('an existing user directive is replaced and remembered', () => {
  const withUser = 'user nobody;\n\nhttp {\n    server {\n        listen 80;\n    }\n}\n'
  const out = setWorkerUser(withUser, 'william', 'staff') as string
  assert.match(out, /^user william staff;$/m)
  assert.match(out, /# was: user nobody;/)
  // And reverting restores exactly what was there.
  assert.equal(removeWorkerUser(out), withUser)
})

check('reverting the worker user restores the original', () => {
  const out = setWorkerUser(NGINX_CONF, 'william', 'staff') as string
  assert.equal(removeWorkerUser(out), NGINX_CONF)
  assert.equal(removeWorkerUser(NGINX_CONF), null)
})

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

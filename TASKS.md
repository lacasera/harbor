# Harbor — implementation tasks

Status as of the design-implementation commit (`27700ca`).

**What exists:** every interface from `CLAUDE.md`, a working `ProcessManager`
(with persisted port allocation), `ConfigStore`, `LogAggregator`,
`PrivilegedHelper`, both backends, MinIO + RabbitMQ drivers, four runtime
drivers with the `VersionResolver`, `ProjectManager` + `NginxManager` + four PHP
framework drivers, dnsmasq/mkcert modules, two analyzers, and the full UI.

**Status:** Phase 1 and the Phase 2 slice are complete. A browser-shaped
request now works: real macOS DNS → nginx → HTTP 301 → trusted HTTPS → the dev
server, with every process's output in the log aggregator. `npm run verify:slice`
parks a real project, spawns its dev server, connects the system nginx and
proves an HTTP request reaches the app on its persisted port with stdout in the
log aggregator — 9/9 steps. Herd has been stopped and Harbor owns this machine's
dev environment; `nginx`, `dnsmasq`, `mkcert` and `nss` are installed.

`npm run verify:slice` covers all 16 steps of it.

Definition of done for v1 is the vertical slice named in `CLAUDE.md`:

> MinIO (service) + an Express app parked at `api.test` (reverse-proxy project)
> + Node runtime resolution + both flowing into the unified log viewer.

---

## P0 — defects found by audit

Small, certain bugs. Fix before building on top of them.

- [x] **P0.1 — Service CPU/RAM never displays.** *(done)*
  `ServicesView.tsx:90` and `ServiceDetail.tsx:72` match usage samples with
  `usage.find(u => u.processId.startsWith(service.id))`, but `processId` is a
  `randomUUID()` (`process-manager.ts:26`) and never begins with a service id.
  Both always render `—`.
  *Fix:* resolve the handle by owner first (as `ProjectDetail` already does):
  find the process where `owner.kind === 'service' && owner.id === service.id`,
  then match `usage.processId === handle.id`. Pass `processes` into both views.
  *Done when:* a running MinIO shows non-zero CPU and memory on its card.

- [x] **P0.2 — Docker compose fragments are lost on restart.** *(done)*
  `DockerBackend.fragments` is an in-memory `Map`. After an app restart,
  starting one Docker service rewrites `~/.harbor/compose/docker-compose.json`
  containing only that service — silently dropping every other service's
  definition from the merged file.
  *Fix:* persist fragments (ConfigStore or a file next to the compose output)
  and reload them in the constructor; merge from the persisted set.
  *Done when:* start RabbitMQ, restart Harbor, start a second Docker service —
  both remain in the compose file and both stay up.

- [x] **P0.3 — MinIO downloads an arm64 binary on Intel Macs.** *(done)*
  `minio.ts:13` hardcodes `darwin-arm64`.
  *Fix:* select from `process.arch`, matching the pattern already used in
  `NodeRuntime`/`DenoRuntime`/`BunRuntime`.
  *Done when:* the URL is arch-derived; verify the x64 URL resolves (HEAD 200).

---

## Phase 1 — make the front door real

The blocking phase. Each task ends with something observable in a browser.

- [x] **1.1 — Wire Harbor's vhosts into the system nginx.** *(done)*
  Homebrew's nginx.conf ends with `include servers/*;` and that directory is
  user-writable, so Harbor connects with a drop-in file and needs no password at
  all on a standard install. Editing nginx.conf is the fallback.
  `NginxManager.ensureRootConfig()` writes `~/.harbor/nginx/harbor.conf`
  containing `include ~/.harbor/nginx/sites/*.conf;`, but **nothing ever adds
  that file to the system `nginx.conf`**, so no vhost is ever served.
  *Build:* detect the brew nginx config path (`$PREFIX/etc/nginx/nginx.conf`),
  and idempotently insert `include <harbor.conf>;` inside its `http {}` block
  via `PrivilegedHelper`. Back up the original once. Add a matching removal
  path. Surface state on the Settings screen ("front door: connected").
  *Done when:* a hand-written vhost in `sites/` responds over HTTP.

- [ ] **1.2 — Own the PHP-FPM pool.**
  `PhpRuntime.fpmSocket()` (`php.ts:35`) *guesses* a path
  (`$PREFIX/var/run/php83-fpm.sock`). Harbor never writes a pool config and
  never starts php-fpm; Homebrew's default pool listens on TCP anyway. Every
  `fpm` vhost currently points at a socket that does not exist.
  *Build:* generate a Harbor-owned pool per installed PHP version writing to a
  socket under `~/.harbor/run/`, start `php-fpm` for that pool through
  `ProcessManager` (so its logs aggregate for free), and have `fpmSocket()`
  return the path Harbor actually created. Add health detection.
  *Done when:* a Laravel app parks and serves at `<name>.test`.

- [x] **1.3 — dnsmasq + resolver working.** *(done)*
  dnsmasq now runs **unprivileged on port 5300** through `ProcessManager`
  (lifecycle and logs for free) rather than as root on 53 via `brew services`.
  The macOS resolver file can name a port, so binding 53 bought nothing and
  would have forced the whole DNS path to run as root. That leaves exactly one
  privileged action ever: writing `/etc/resolver/<tld>`.
  Verified: `dscacheutil` resolves `*.test` → 127.0.0.1 through the real macOS
  resolver stack.
  `DnsmasqManager` is written but has never been executed. Verify the brew
  path, the fragment location, `/etc/resolver/<tld>`, and the restart command
  on a real machine; fix what the first run reveals.
  *Done when:* `dig foo.test @127.0.0.1` returns `127.0.0.1` and a browser
  resolves an arbitrary `*.test` name without an `/etc/hosts` entry.

- [x] **1.4 — mkcert TLS working.** *(done)*
  The CA was already trusted in the system keychain, so issuance needs no
  privileged step at all. Securing a site now **issues the certificate on
  demand** — previously the toggle only picked up a cert that happened to exist,
  so enabling TLS silently kept serving plain HTTP.
  Verified: `/usr/bin/curl` (Secure Transport, so it consults the keychain)
  loads `https://<site>.test:8443` with no `-k`.
  Same: `TlsManager` is unexercised. Confirm CA install, per-site cert issue,
  and that a `secure: true` vhost serves HTTPS without a browser warning.
  Wire "Secure (TLS)" on the project Overview to issue the cert before
  re-rendering the vhost — today the toggle sets the flag and the vhost falls
  back to HTTP because no cert file exists (`projects/index.ts:236`).
  *Done when:* toggling TLS on a parked site yields a trusted `https://` load.

- [x] **1.5 — Re-render vhosts on boot.** *(done)*
  Vhosts are written on park/update only. If the TLD changes, a cert is added,
  or the file is deleted, state drifts.
  *Build:* re-render every project's vhost during `HarborApp.start()`, then run
  one `nginx -t` and reload if it passes.
  *Done when:* deleting `sites/*.conf` and restarting restores every site.

---

## Phase 2 — the vertical slice

- [x] **2.1 — dev server served through nginx, end to end.** *(done)*
  Covered by `npm run verify:slice`. Uses an explicit Host header rather than
  DNS; finish 1.3 to drop that caveat.
  Park a real Express project, confirm detection → `node-server` →
  reverse-proxy, port allocated and persisted, `npm run dev` spawned with
  `PORT` injected, nginx proxying, and the port stable across an app restart.
  *Done when:* `curl http://api.test` returns the app, twice, across a restart.

- [x] **2.2 — MinIO end to end.** *(done: `npm run verify:service`)*
  Install through the UI, start, health goes green, real ports bound, Copy
  `.env` produces values matching the running instance (not schema defaults).
  *Done when:* the copied block works verbatim in a Laravel `.env`.

- [x] **2.3 — dev-server output reaches the aggregator.** *(done, in verify:slice)*
- [x] **2.3b — MinIO logs alongside it in the viewer.** *(done)*
  MinIO stdout and the Express dev server both appear, tagged, filterable,
  following.
  *Done when:* source chips list both and filtering isolates each.

- [x] **2.4 — Write the slice up as a script.** *(done: `scripts/verify-slice.ts`)*

---

## Defects found by running it

Every one of these was invisible to the type checker and to the original tests.

- [x] **Every generated vhost was syntactically invalid.** `render()` nested the
  indented body array inside the outer array, so `join('\n')` stringified it
  into one comma-separated line. nginx rejected it outright. The unit tests
  passed because they regex-matched the whole string, and a substring match
  succeeds just as well on a mangled line. Tests now assert line structure.
- [x] **Dev servers never spawned.** `ProcessManager` runs with `shell: false`
  while `NodeServerProjectType` returns a bare `npm run dev`, so every start
  failed with ENOENT. Added `resolve-binary.ts`, searching the pinned runtime's
  bin dir before PATH.
- [x] **`spawn()` returned before the process existed**, so callers got a handle
  claiming `starting` for a process that had already failed. It now settles on
  the first spawn/error event and rejects with the real reason.
- [x] **`reload()` escalated to a root prompt when nginx simply wasn't running.**
  Now a no-op, and the unprivileged reload is tried before escalating at all.
- [x] **Config writes could be lost on a prompt exit** (debounced onto a
  microtask). Added `ConfigStore.flush()`, called from `shutdown()`.
- [x] **`which()` only searched `bin/`**, so Homebrew daemons installed to
  `sbin/` — dnsmasq among them — looked uninstalled.
- [x] **A secured site was unreachable over HTTP.** The vhost listened on 443
  only, so `http://<site>` fell through to whichever vhost was that port's
  default server, serving another project or a 403. Securing a site now also
  emits a 301 redirect block, as Valet and Herd do.
- [x] **`dns.start()` returned before dnsmasq was listening**, so the next query
  failed for no real reason. It now polls until the probe answers.
- [x] **One stale vhost broke every site.** nginx validates the whole config at
  once, so an orphan left by a forgotten project (or an older build) failed
  `nginx -t` for all of them. Boot now sweeps vhosts with no matching project.

## Phase 3 — correctness and robustness

- [x] **3.1 — Service lifecycle on quit/crash.** *(done)* Verify children die with the
  app (`before-quit` → `shutdown`), and that a crashed service reports
  `crashed` rather than silently showing stopped.
- [x] **3.2 — Port conflicts.** *(done)* Allocator skips a port held by a foreign
  process, and surfaces a clear error when the range is exhausted.
- [x] **3.3 — Health-check cost.** *(done)* `ServiceRegistry.describe()` health-checks on
  every call; `services:list` runs on every UI mount. Cache briefly or make the
  UI subscribe rather than re-list.
- [x] **3.4 — Config validation.** *(done)* `ajv` is a dependency but unused. Validate
  `values` against `configSchema` in `updateConfig` and return field errors the
  form can display.
- [x] **3.5 — Error surfacing.** *(done)* Driver failures (install, start) currently
  reach the UI as raw `Error.message`. Decide on a consistent shape.

---

## Phase 4 — remaining services

Each is one driver file plus one line in `services/index.ts` — no UI work. Order
by usefulness:

- [ ] **4.1** Meilisearch (native)
- [ ] **4.2** Elasticsearch (docker)
- [ ] **4.3** LocalStack (docker)
- [ ] **4.4** OpenSearch (docker)
- [ ] **4.5** Kafka (docker)

Each done when: installs, starts, health-checks, logs aggregate, and its
`envHints` produce a correct block against the running instance.

---

## Phase 5 — code intelligence

- [ ] **5.1 — Validate the Eloquent analyzer against real apps.** It is
  regex-based by design; run it over two or three real Laravel codebases and
  fix what it misses. Warnings must name what it could not parse.
- [ ] **5.2 — Symfony/Doctrine analyzer** (entity attributes → same graph).
- [ ] **5.3 — File-watch invalidation.** The cache invalidates on mtime at read
  time; add a watcher so an open Insights tab refreshes.
- [ ] **5.4 — Project ↔ service association.** The Env tab currently aggregates
  *every running service* because no association exists (stated in the UI).
  Add per-project service selection, persist it, and scope the block.

---

## Phase 6 — packaging

- [ ] **6.1** Icon and `build/` assets.
- [ ] **6.2** Signing + notarization.
- [ ] **6.3** `SMJobBless` helper to replace `sudo-prompt` — all privileged
  calls already funnel through `PrivilegedHelper`, so this is one file.
- [ ] **6.4** Auto-update (`electron-updater` is already a dependency).

---

## Testing

Today: `npm run smoke` (9 pure-logic checks) and `npm run typecheck`. There is
no test runner.

- [ ] **T.1** Add a real runner (`vitest`) and port `scripts/smoke.ts` to it.
- [ ] **T.2** Unit-test `PortAllocator` persistence, `VersionResolver` priority
  order, and `ServiceRegistry.envBlock` live-value resolution.
- [ ] **T.3** Integration test for the Phase 2 slice, gated behind an env flag
  so it only runs where nginx/dnsmasq are installed.

---

## Out of scope for v1

Request inspector (premium, built last), Go project type, global shell exposure
of runtimes, Windows/Linux support.

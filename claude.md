# CLAUDE.md

Guidance for Claude when working in this repository.

---

## What we're building

A macOS desktop application (Electron) that is a **centralized local development environment platform** — a superset of Laravel Herd. It manages local domains, TLS, multiple language runtimes, and a catalog of backing services, all through a friendly UI. Nginx is the single front door for all `.test` domains; everything else plugs in behind it.

**Not** a PHP-only tool. PHP/Laravel is one project type among several (Node/Express, Go later, anything that binds a port).

### Feature scope

- Park/link project directories, auto-served at `<name>.test` with local TLS.
- Multiple **project types**: PHP (nginx→FPM), Node servers (nginx→reverse-proxy), static, Go (later).
- **Runtimes**: Node, Bun, Deno, PHP — version-managed, per-project resolution.
- **Services**: MinIO (S3), LocalStack (AWS), Elasticsearch, OpenSearch, Meilisearch, RabbitMQ, Kafka — each start/stop/health/config through a uniform driver.
- **Unified log viewer** across all services and dev-server processes, with filtering/search/follow.
- **Env-var export**: every service exposes copy-paste-ready connection vars for a project's `.env` (see "Env-var export" below). This is a first-class, uniform feature — not per-service ad hoc.
- **Project overview / code intelligence**: static analysis of a parked project to visualize data-model relationships (ERD), dependency trees, and UML/structure diagrams (see "Code intelligence" below).
- **Request inspector** for Laravel sites (premium, built last).
- Per-service resource (CPU/RAM) display.

---

## Core architecture

Three distinct primitives. **Do not conflate them** — this is the most important design rule in the codebase.

| Primitive | Examples | Lifecycle | Managed by |
|-----------|----------|-----------|------------|
| **Service** | MinIO, Kafka, Elasticsearch | long-running, start/stop/health | `ServiceRegistry` |
| **Runtime** | Node, Bun, Deno, PHP | versioned toolchain, install/pin/resolve | `RuntimeManager` |
| **Project** | a Laravel app, an Express app | detected type, served via nginx | `ProjectManager` |

A **Process** (the user's `bun run dev`, `php artisan serve`) is spawned *using* a runtime, on behalf of a project, and is monitored by the shared `ProcessManager`.

### Process / IPC topology

```
┌─────────────────────────────────────────────┐
│  Renderer (React + TypeScript)               │
│  service cards · config forms (schema-driven)│
│  unified log viewer · project list · request │
│  inspector · resource meters                 │
└──────────────────┬──────────────────────────┘
                   │ typed IPC (contextBridge, no nodeIntegration)
┌──────────────────┴──────────────────────────┐
│  Main process — orchestrator                 │
│  ┌────────────────────────────────────────┐  │
│  │ ServiceRegistry   (ServiceDriver[])    │  │
│  │ RuntimeManager    (RuntimeDriver[])    │  │
│  │   └ VersionResolver (per-project)      │  │
│  │ ProjectManager    (ProjectType[])      │  │
│  │ ProcessManager    (spawn/monitor/ports)│  │
│  │ LogAggregator     (tail + stream)      │  │
│  │ Backends: NativeBackend / DockerBackend│  │
│  │ NginxManager      (vhost gen + reload) │  │
│  │ ConfigStore       (persisted state)    │  │
│  │ PrivilegedHelper  (sudo-scoped ops)    │  │
│  └────────────────────────────────────────┘  │
└──────────────────────────────────────────────┘
```

**Rule:** the renderer never spawns processes, touches the filesystem outside its own state, or runs privileged commands. Everything goes through typed IPC to the main process.

---

## Key interfaces

These interfaces are the backbone. New services/runtimes/project-types are added by implementing a driver and registering it — **never** by adding hardcoded UI panels or special cases.

### ServiceDriver

```typescript
interface ServiceDriver {
  id: string;                         // "elasticsearch"
  displayName: string;
  backend: "native" | "docker";
  install(version: string): Promise<void>;
  start(config: ServiceConfig): Promise<ProcessHandle>;
  stop(): Promise<void>;
  healthCheck(): Promise<ServiceStatus>;
  defaultPorts: number[];
  configSchema: JSONSchema;           // drives the settings UI automatically
  logSources: LogSource[];            // files to tail or stdout streams
  envHints: Record<string, string>;   // snippet to paste into a project's .env
}
```

The UI (card, toggle, config form, log wiring, `.env` snippet) **generates itself** from this metadata. If you find yourself writing service-specific UI, stop and push the variation into the driver.

### RuntimeDriver

```typescript
interface RuntimeDriver {
  id: string;                         // "node" | "bun" | "deno" | "php"
  install(version: string): Promise<void>;
  installedVersions(): Promise<string[]>;
  availableVersions(): Promise<string[]>;   // remote list
  resolveBinary(version: string): string;   // absolute path to the binary
  pin(projectPath: string, version: string): Promise<void>;
  activeVersion(projectPath: string): Promise<string>;
}
```

Versions live under `~/.<appname>/runtimes/<runtime>/<version>` so we never fight the user's existing nvm/asdf/volta. **v1 runtimes are isolated** (only our app sees them); global shell exposure is a later, explicit opt-in.

### ProjectType

```typescript
interface ProjectType {
  id: string;                         // "php" | "node-server" | "static" | "go"
  detect(dir: string): Promise<boolean>;
  serveModel: "fpm" | "reverse-proxy" | "static";
  resolveRuntime(dir: string): RuntimeRef;
  startCommand(dir: string): string | null;   // null for FPM-served PHP
  defaultPort?: number;
}
```

Nginx is always the front door regardless of `serveModel`; only what sits behind it changes:
- `fpm` → `fastcgi_pass` to PHP-FPM socket
- `reverse-proxy` → `proxy_pass http://127.0.0.1:<allocatedPort>`
- `static` → nginx serves files directly

### VersionResolver

Resolve the active runtime version per project, in priority order:
1. App override (set via UI, in `ConfigStore`)
2. `.nvmrc` / `.node-version` / `.bun-version` / `deno.json` pins
3. `package.json` `engines` / `volta` / `packageManager`
4. Runtime default

### PhpFrameworkDriver (sub-driver *under* the `php` ProjectType)

The `php` ProjectType's `fpm` serve model is not one-size-fits-all: every framework has a different docroot, front controller, and rewrite logic. A `PhpFrameworkDriver`, selected by detection, parameterizes the fastcgi vhost. This nests **under** `ProjectType` — it is not a peer of it. `ProjectType` picks the serve model; the framework driver parameterizes the `fpm` model.

```typescript
interface PhpFrameworkDriver {
  id: string;                                 // "laravel" | "symfony" | "wordpress" | "plain"
  detect(dir: string): Promise<boolean>;
  docroot(dir: string): string;               // "public" | "web" | "" (root)
  frontController(dir: string): string;       // "index.php" | "app.php"
  rewrites(dir: string): NginxRewriteRule[];  // framework-specific try_files / rules
  // optional: isolatedPhpVersion(dir) — per-site PHP version pin (Valet parity)
}
```

Mirror Laravel Valet's driver contract (`serves()`, `frontControllerPath()`, `isStaticFile()`) so the large existing community driver ecosystem can be used as reference. Ship Laravel, WordPress, and plain-PHP drivers first (plus Symfony) to prove the fastcgi template is parameterizable.

**Detection order — specific before generic.** Laravel and Symfony both have `public/index.php`; distinguish by `artisan` (Laravel) vs `bin/console` + Symfony composer deps. WordPress by `wp-config.php` / `wp-load.php`. Fall through to `plain`.

Serving flow for a PHP project:
```
park dir → ProjectManager detects type = "php"
        → PhpFrameworkRegistry.detect() picks the framework driver
        → NginxManager renders the fastcgi vhost using
          driver.docroot() + driver.frontController() + driver.rewrites()
        → VersionResolver picks the PHP version (per-project)
```

### Env-var export (uniform across all services)

Every `ServiceDriver` already declares `envHints: Record<string,string>`. The env-export feature is built entirely on that field — **no per-service export code**. Requirements:
- Each service card exposes a **Copy .env** action that renders its `envHints` as `KEY=value` lines and copies to clipboard.
- Values must reflect **live config** (actual bound port, resolved credentials, container host), not static defaults — resolve `envHints` against the running `ServiceConfig`, not the schema default.
- Support **"copy all"** at the project level: aggregate `envHints` from every service the user has selected/enabled, deduped, as one block.
- Provide a per-service **preview** (read-only) of the block before copy.
If a new service needs export, it gets it for free by populating `envHints`. Do not special-case.

---

## Execution backends

Each driver declares its backend.

- **NativeBackend** (brew/binaries): PHP, nginx, dnsmasq, MinIO, Meilisearch. Fast, no Docker tax.
- **DockerBackend** (Colima preferred over Docker Desktop — lighter, scriptable): Elasticsearch, OpenSearch, Kafka, RabbitMQ, LocalStack. Each Docker driver emits a compose fragment; merge and `docker compose up -d`. Detect Colima; offer to install if missing.

---

## Critical subsystems — get these right early

### Port allocation (build into ProcessManager NOW)
Any `reverse-proxy` project needs a stable port. The allocator must: find a free port, **persist** the assignment so `api.test` is stable across restarts, and inject it both into the nginx vhost (`proxy_pass`) and the child process (`PORT` env). Retrofitting this after multiple projects exist is painful.

### Privilege escalation
Writing to `/etc/resolver/test`, binding 80/443, and modifying the Keychain need root.
- v1: `sudo-prompt` for one-off elevated commands.
- Later: an `SMJobBless` privileged helper (proper, notarization-friendly).
Keep all privileged operations funneled through `PrivilegedHelper` — never scatter `sudo` calls.

### Local domains & TLS
- `dnsmasq` resolving `*.test` → `127.0.0.1`; resolver file at `/etc/resolver/test`.
- `mkcert` to generate a local CA + per-site certs; trust the CA in the macOS Keychain.

### LogAggregator
Central tail of every driver's `logSources` plus every managed process's stdout. Tag each line with `{service, timestamp, level}`, stream to the renderer over IPC. Dev-server stdout flows in **for free** because those processes go through `ProcessManager`. Build this before there are many services.

### Code intelligence (project overview) — a distinct subsystem
This is **static analysis**, categorically different from the runtime-management everything else does. It parses a parked project's source to produce the overview UI: ERD (data-model relationships), dependency trees, and UML/structure diagrams. Treat it as its own subsystem (`CodeIntelligence`), analyzer-per-ecosystem, mirroring the driver pattern:

```typescript
interface ProjectAnalyzer {
  id: string;                                  // "laravel-eloquent" | "node-deps" | "composer-deps"
  supports(project: Project): boolean;
  analyze(dir: string): Promise<AnalysisResult>;  // models+relations, dep graph, modules
}
```

Concrete analyzers to plan for:
- **Data models / ERD** — Laravel: parse Eloquent models + migrations for tables, columns, and relationships (`hasMany`/`belongsTo`/`belongsToMany`). Symfony/Doctrine: parse entity annotations/attributes. Emit a normalized `{entities, relations}` graph.
- **Dependency tree** — read `composer.json`/`composer.lock` and `package.json`/lockfiles; build a graph (direct + transitive).
- **UML / structure** — class/module relationships from the above; render via a diagram format.

Rendering: normalize every analyzer to a common graph model, render client-side. **Mermaid** (erDiagram, classDiagram, flowchart) is the pragmatic default — analyzers emit Mermaid or a neutral graph the renderer converts. Keep parsing in the **main process** (filesystem access, may shell out to `composer`/AST tools); the renderer only draws.

Analysis is **on-demand and cached** (invalidate on file-watch of relevant sources) — never block park/serve on it. It is a later-stage feature; scaffold the interface, ship analyzers after the runtime platform is solid.

---

## Build order (de-risks the hard parts first)

1. **Electron shell** + typed IPC + `ProcessManager` (with **port allocation**) + the three driver interfaces.
2. **MinIO** as the first `ServiceDriver` (native) — start/stop/health through the abstraction.
3. **Schema-driven UI**: service card + config form generated from `configSchema`. Prove the abstraction pays off.
4. **LogAggregator + unified log viewer**, MinIO logs wired in.
5. **RuntimeManager + VersionResolver**: Node (via fnm or managed tarballs) and Deno end-to-end.
6. **ProjectManager + NginxManager**: park a project; support both `fpm` (a Laravel app) and `reverse-proxy` (an Express app at `api.test`) side by side from day one.
7. **DockerBackend + Colima**: add RabbitMQ — proves the second backend.
8. **Remaining services** as drivers: Elasticsearch, OpenSearch, Meilisearch, Kafka, LocalStack.
9. **dnsmasq + mkcert TLS** module for real `.test` + HTTPS.
10. **Request inspector** for Laravel (premium, last).

The first vertical slice to target: **MinIO (service) + an Express app parked at `api.test` (reverse-proxy project) + Node runtime resolution + both flowing into the unified log viewer.** That single slice exercises every core subsystem.

---

## Tech stack

- **Electron** (latest LTS-aligned), **TypeScript** everywhere, strict mode on.
- **React** renderer. Keep it thin — presentation + IPC calls only.
- IPC via `contextBridge` / `ipcRenderer.invoke`; `nodeIntegration: false`, `contextIsolation: true`.
- Build: **electron-vite** (or electron-forge + vite). Package/notarize for macOS.
- State persistence: `ConfigStore` backed by a JSON/SQLite store under `~/.<appname>/`.
- Process spawning: Node `child_process`; wrap all of it in `ProcessManager`, never spawn ad hoc.

---

## Conventions & guardrails

- **Drivers over special-cases.** Adding a service, runtime, or project type must mean *implementing an interface and registering it*, nothing more. Reject PRs that add per-service branches in shared code or bespoke UI panels.
- **Renderer is sandboxed.** No filesystem, no spawning, no privileged calls in the renderer. All of it via typed IPC.
- **All privileged ops through `PrivilegedHelper`.** No stray `sudo`.
- **All spawned processes through `ProcessManager`.** This is what gives lifecycle, port allocation, and free log aggregation.
- **Isolated runtimes in v1.** Don't shim the user's shell yet; don't touch their nvm/asdf/volta setup.
- **Resource awareness early.** Kafka and Elasticsearch are memory-hungry; surface per-service CPU/RAM so users (and we, in dev) see what's eating the machine.
- **Detection is a convenience, not a contract.** Auto-detect project type on park, but always let the user override the type, runtime version, and start command in the UI.
- Prefer shelling out to well-tested tools (fnm, mkcert, colima, brew) over reimplementing them.

---

## Repository layout (target)

```
/src
  /main                # Electron main process
    /core              # ProcessManager, LogAggregator, ConfigStore, PrivilegedHelper
    /backends          # NativeBackend, DockerBackend
    /services          # one file per ServiceDriver (minio.ts, kafka.ts, …)
    /runtimes          # one file per RuntimeDriver (node.ts, bun.ts, deno.ts, php.ts)
    /projects          # ProjectType detectors + NginxManager + VersionResolver
      /php-frameworks  # PhpFrameworkDriver impls (laravel.ts, symfony.ts, wordpress.ts, plain.ts)
    /intelligence      # CodeIntelligence + ProjectAnalyzer impls (eloquent-erd.ts, deps.ts, …)
    /ipc               # typed IPC handlers
  /renderer            # React UI
    /components        # ServiceCard, ConfigForm, LogViewer, ProjectList, …
    /ipc               # typed client wrappers
  /shared              # interfaces, JSONSchema types, IPC contracts
/resources             # nginx vhost templates, compose fragments, mkcert assets
```

---

## When extending

- **New service** → add `src/main/services/<id>.ts` implementing `ServiceDriver`, register it. Done. UI appears automatically.
- **New runtime** → add `src/main/runtimes/<id>.ts` implementing `RuntimeDriver`, register it.
- **New project type** (e.g. Go) → add a `ProjectType` with a detector + `serveModel`, plus a `RuntimeDriver` if the toolchain is new. Reuses the existing reverse-proxy path entirely.
- **New PHP framework** → add a `PhpFrameworkDriver` under `projects/php-frameworks/`, register it, mind detection order. No nginx-template changes.
- **New env export** → nothing to build; populate the service's `envHints`.
- **New overview/diagram** → add a `ProjectAnalyzer` under `intelligence/` emitting the normalized graph.
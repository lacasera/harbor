# Harbor

A macOS desktop app (Electron) that centralizes local development: `.test` domains
with TLS, multiple language runtimes, and a catalog of backing services — all
behind one nginx front door.

## Getting started

```bash
npm install
npm run dev        # electron-vite dev server + Electron
npm run build      # typecheck + bundle to out/
npm run smoke      # headless checks of vhost rendering, detection, resolution
npm run dist       # package a macOS .dmg
```

State lives under `~/.harbor/` (config, runtimes, service data, certs, vhosts,
logs). Nothing is written outside it.

## The three primitives

These are deliberately separate. Conflating them is the one thing that breaks
the architecture.

| Primitive   | Managed by        | Lives in                |
|-------------|-------------------|-------------------------|
| **Service** | `ServiceRegistry` | `src/main/services/`    |
| **Runtime** | `RuntimeManager`  | `src/main/runtimes/`    |
| **Project** | `ProjectManager`  | `src/main/projects/`    |

A **process** (`bun run dev`, MinIO) is spawned *using* a runtime, on behalf of a
project or service, and is monitored by the shared `ProcessManager`.

## Extending

Everything is drivers. Adding capability means implementing an interface and
registering it — never adding a branch in shared code or a bespoke UI panel.

| I want to add…      | Do this                                                             |
|---------------------|---------------------------------------------------------------------|
| A service           | `src/main/services/<id>.ts` implementing `ServiceDriver`, register in `services/index.ts`. Card, config form, logs and `.env` export appear automatically. |
| A runtime           | `src/main/runtimes/<id>.ts` implementing `RuntimeDriver`, register in `runtimes/index.ts`. |
| A project type      | Implement `ProjectType` in `projects/types/`, register in `ProjectManager`. Reuses the existing serve models. |
| A PHP framework     | `projects/php-frameworks/<id>.ts` implementing `PhpFrameworkDriver`. Mind the `priority` — specific before generic. No nginx template changes. |
| An `.env` export    | Nothing. Populate the driver's `envHints`. |
| A diagram/overview  | A `ProjectAnalyzer` in `intelligence/` emitting the normalized graph. |

## Rules that are load-bearing

- **The renderer is sandboxed.** No filesystem, no spawning, no privileged calls.
  Everything crosses `src/shared/ipc.ts`, which types both sides of the boundary.
- **All spawning goes through `ProcessManager`.** That is what gives lifecycle,
  stable port allocation, and free log aggregation.
- **All root operations go through `PrivilegedHelper`.** No stray `sudo`.
- **Ports are persisted.** `api.test` keeps its `proxy_pass` port across restarts.
- **Runtimes are isolated.** We never touch the user's nvm/asdf/volta or shell.
- **Detection is a convenience, not a contract.** Users can override type,
  runtime version and start command.

## Implemented so far

- Electron shell, typed IPC, `ProcessManager` with persisted port allocation
- `ConfigStore` (atomic writes), `LogAggregator` (file tails + process stdout),
  `PrivilegedHelper`, resource sampling
- Native and Docker backends; MinIO (native) and RabbitMQ (Docker) drivers
- Schema-driven service cards, config forms and `.env` export
- Node / Bun / Deno / PHP runtime drivers with the priority-ordered
  `VersionResolver`
- `ProjectManager` + `NginxManager` rendering all three serve models; Laravel,
  Symfony, WordPress and plain PHP framework drivers
- dnsmasq and mkcert modules
- `CodeIntelligence`: Eloquent ERD, npm and Composer dependency graphs, Mermaid
  output

## Not built yet

Elasticsearch, OpenSearch, Meilisearch, Kafka and LocalStack drivers; the Go
project type; the Laravel request inspector; `SMJobBless` privileged helper.

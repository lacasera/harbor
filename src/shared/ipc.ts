import type {
  ConfigUpdateResult,
  EnvBlock,
  ServiceDescriptor,
  ServiceInstance,
  ServiceInstanceDescriptor,
  ServiceInstanceKey,
  ServiceInstanceRef
} from './service.js'
import type {
  ResolvedVersion,
  RuntimeConfigFile,
  RuntimeDescriptor,
  RuntimeId,
  UpdateInfo
} from './runtime.js'
import type {
  ProjectDescriptor,
  ProjectEnvFile,
  ProjectProcessOverride,
  ProjectTypeId
} from './project.js'
import type { ProcessHandle, ResourceUsage } from './process.js'
import type { LogLine, LogQuery } from './logs.js'
import type { AnalysisResult } from './intelligence.js'
import type { Diagnostic } from './diagnostics.js'

/** Where the `harbor` command lives and whether a shell can find it. */
export interface CliStatus {
  installed: boolean
  path: string
  linked: boolean
  linkPath: string
  onPath: boolean
}
import type { ContainerRuntimeDescriptor } from './container-runtime.js'

export interface UpdateStatus {
  state: 'current' | 'available' | 'disabled' | 'error'
  currentVersion: string
  availableVersion?: string
  detail?: string
}

export interface TlsStatus {
  installed: boolean
  caInstalled: boolean
}

export interface DnsStatus {
  installed: boolean
  running: boolean
  resolverConfigured: boolean
  port: number
  /** dnsmasq itself answered a probe correctly, independent of /etc/resolver. */
  resolves: boolean
}

/**
 * Whether the system nginx is actually reading Harbor's vhosts. `connected`
 * false means every generated vhost is inert.
 */
export interface NginxStatus {
  installed: boolean
  running: boolean
  connected: boolean
  /** The system nginx.conf Harbor edits, when it can be found. */
  configPath: string | null
  /** Harbor's own include file. */
  harborConfig: string
  strategy: 'drop-in' | 'config-edit' | null
  /** The user the master runs as; root is required to bind 80/443. */
  runningAs: string | null
  /** Ports the running master is actually bound to. */
  listening: number[]
  /** The user nginx workers run as; `nobody` cannot read parked projects. */
  workerUser: string | null
}

/** User-editable app settings, surfaced on the Settings screen. */
export interface AppSettings {
  tld: string
  parkedDirs: string[]
  autoStartServices: boolean
  /** Ports the generated vhosts listen on. 80/443 require a root nginx. */
  httpPort: number
  httpsPort: number
  /** Chosen container runtime, or `auto`. */
  containerRuntime: string
}

/**
 * The single source of truth for the renderer/main boundary. Every entry is
 * `[argsTuple, result]`. Adding a channel here and nowhere else is a type
 * error on both sides — which is the point.
 */
export interface IpcContract {
  'app:info': [[], { name: string; version: string; homeDir: string }]
  'app:checkForUpdates': [[], UpdateStatus]
  /**
   * Open a URL in the user's browser. An explicit call rather than relying on
   * the window-open handler intercepting an anchor: this way a click either
   * works or reports why, instead of doing nothing observable.
   */
  'app:openExternal': [[url: string], void]
  /** Everything Harbor depends on, and whether it is there. */
  'app:diagnostics': [[], Diagnostic[]]

  /** The `harbor` command: where it is, and whether it is on PATH. */
  /**
   * Start Harbor when the user logs in. Read from the operating system rather
   * than mirrored in Harbor's config: the user can change it in System
   * Settings too, and a copy would go stale without either side knowing.
   */
  'app:loginItem': [[], boolean]
  'app:setLoginItem': [[enabled: boolean], boolean]

  'cli:status': [[], CliStatus]
  'cli:link': [[], CliStatus]
  'cli:unlink': [[], CliStatus]

  /** Container runtimes: what is available, and which one Harbor uses. */
  'containers:list': [[force?: boolean], ContainerRuntimeDescriptor[]]
  'containers:select': [[id: string], ContainerRuntimeDescriptor[]]
  'containers:start': [[id: string], ContainerRuntimeDescriptor[]]

  /** The catalogue: every service, each carrying its instances. */
  'services:list': [[], ServiceDescriptor[]]
  'services:install': [[serviceId: string, version: string], void]
  /**
   * Every channel below acts on ONE instance. `serviceId` alone no longer
   * identifies anything actionable — two projects can each own a MySQL.
   */
  'services:start': [[ref: ServiceInstanceRef], ServiceInstanceDescriptor]
  'services:stop': [[ref: ServiceInstanceRef], ServiceInstanceDescriptor]
  'services:updateConfig': [
    [ref: ServiceInstanceRef, patch: Partial<ServiceInstance>],
    ConfigUpdateResult
  ]
  'services:envBlock': [[ref: ServiceInstanceRef], EnvBlock]
  'services:envBlocks': [[refs: ServiceInstanceRef[]], EnvBlock[]]

  'runtimes:list': [[], RuntimeDescriptor[]]
  'runtimes:available': [[runtimeId: RuntimeId], string[]]
  'runtimes:install': [[runtimeId: RuntimeId, version: string], void]
  'runtimes:uninstall': [[runtimeId: RuntimeId, version: string], void]
  'runtimes:resolve': [[runtimeId: RuntimeId, projectPath: string], ResolvedVersion]
  'runtimes:setDefault': [[runtimeId: RuntimeId, version: string], RuntimeDescriptor[]]
  /** Editable configuration for one installed version, e.g. php.ini. */
  /** Newer versions of what is installed, keyed `<runtimeId>#<version>`. */
  'runtimes:updates': [[force?: boolean], Record<string, UpdateInfo>]
  'runtimes:update': [[runtimeId: RuntimeId, version: string], RuntimeDescriptor[]]
  'runtimes:configFiles': [[runtimeId: RuntimeId, version: string], RuntimeConfigFile[]]
  'runtimes:writeConfig': [
    [runtimeId: RuntimeId, version: string, fileId: string, content: string],
    RuntimeConfigFile[]
  ]

  'projects:list': [[], ProjectDescriptor[]]
  'projects:park': [[dir: string], ProjectDescriptor[]]
  'projects:link': [[dir: string], ProjectDescriptor]
  'projects:forget': [[projectId: string, options?: { destroyData?: boolean }], void]
  'projects:start': [[projectId: string], ProjectDescriptor]
  'projects:stop': [[projectId: string], ProjectDescriptor]
  'projects:update': [
    [
      projectId: string,
      patch: {
        typeId?: ProjectTypeId
        startCommandOverride?: string | null
        runtimeOverride?: { runtime: RuntimeId; version: string } | null
        secure?: boolean
        /** Re-run detection and drop any manual type override. */
        redetectType?: boolean
      }
    ],
    ProjectDescriptor
  ]
  'projects:chooseDirectory': [[], string | null]
  /** The project's own .env, read from disk. */
  'projects:envFile': [[projectId: string], ProjectEnvFile]

  /** Companion processes: queue workers, schedulers, asset builds. */
  'projects:startProcess': [[projectId: string, specId: string], ProjectDescriptor]
  'projects:stopProcess': [[projectId: string, specId: string], ProjectDescriptor]
  'projects:updateProcess': [
    [projectId: string, specId: string, patch: ProjectProcessOverride],
    ProjectDescriptor
  ]
  'projects:addProcess': [
    [
      projectId: string,
      input: { label: string; command: string; runtime?: string; autoStart?: boolean }
    ],
    ProjectDescriptor
  ]
  'projects:removeProcess': [[projectId: string, specId: string], ProjectDescriptor]

  /**
   * Per-project service stacks. Attaching gives the project its own instance —
   * its own ports, credentials, configuration and data — rather than pointing
   * it at a shared one.
   */
  /**
   * These return the catalogue rather than the project: a project record no
   * longer says anything about its services, and returning the catalogue means
   * the caller cannot be left waiting on a push to see what it just did.
   */
  'projects:attachService': [[projectId: string, serviceId: string], ServiceDescriptor[]]
  'projects:detachService': [[projectId: string, serviceId: string], ServiceDescriptor[]]
  'projects:startStack': [[projectId: string], ServiceDescriptor[]]
  'projects:stopStack': [[projectId: string], ServiceDescriptor[]]

  'processes:list': [[], ProcessHandle[]]
  'processes:stop': [[processId: string], void]
  'processes:usage': [[], ResourceUsage[]]

  'logs:query': [[query: LogQuery], LogLine[]]
  'logs:sources': [[], string[]]
  'logs:clear': [[], void]

  'intelligence:analyze': [[projectId: string, force?: boolean], AnalysisResult[]]
  'intelligence:mermaid': [[projectId: string, kind: 'erDiagram' | 'classDiagram'], string]

  'settings:get': [[], AppSettings]
  'settings:update': [[patch: Partial<AppSettings>], AppSettings]

  'tls:status': [[], TlsStatus]
  'tls:install': [[], TlsStatus]
  'tls:installCa': [[], TlsStatus]

  'dns:status': [[], DnsStatus]
  'dns:install': [[], DnsStatus]
  'dns:start': [[], DnsStatus]
  'dns:stop': [[], DnsStatus]
  /** Writes /etc/resolver/<tld>. The only privileged step in DNS setup. */
  'dns:configureResolver': [[], DnsStatus]
  /** Clear macOS resolver caches; stale negatives survive a dnsmasq restart. */
  'dns:flush': [[], DnsStatus]

  'nginx:status': [[], NginxStatus]
  'nginx:reload': [[], void]
  /** Add Harbor's include to the system nginx.conf. Prompts for root. */
  'nginx:connect': [[], NginxStatus]
  'nginx:disconnect': [[], NginxStatus]
  /** Full restart — a reload cannot move a master to different ports. */
  'nginx:restart': [[], NginxStatus]
}

export type IpcChannel = keyof IpcContract
export type IpcArgs<C extends IpcChannel> = IpcContract[C][0]
export type IpcResult<C extends IpcChannel> = IpcContract[C][1]

/** Main → renderer pushes. */
export interface IpcEvents {
  'log:line': LogLine
  'service:changed': ServiceInstanceDescriptor
  /** An instance was removed; the key it had. */
  'service:detached': ServiceInstanceKey
  'project:changed': ProjectDescriptor
  /** A project was forgotten; the id it had. */
  'project:forgotten': string
  'process:changed': ProcessHandle
  'usage:sample': ResourceUsage[]
  /** A project's sources changed; its cached analysis was dropped. */
  'analysis:invalidated': string
}

export type IpcEventName = keyof IpcEvents

/** Shape exposed on `window.harbor` by the preload bridge. */
export interface HarborBridge {
  invoke<C extends IpcChannel>(channel: C, ...args: IpcArgs<C>): Promise<IpcResult<C>>
  on<E extends IpcEventName>(event: E, listener: (payload: IpcEvents[E]) => void): () => void
}

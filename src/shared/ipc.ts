import type { EnvBlock, ServiceConfig, ServiceDescriptor } from './service.js'
import type { RuntimeDescriptor, ResolvedVersion, RuntimeId } from './runtime.js'
import type { ProjectDescriptor, ProjectTypeId } from './project.js'
import type { ProcessHandle, ResourceUsage } from './process.js'
import type { LogLine, LogQuery } from './logs.js'
import type { AnalysisResult } from './intelligence.js'

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
}

/** User-editable app settings, surfaced on the Settings screen. */
export interface AppSettings {
  tld: string
  parkedDirs: string[]
  autoStartServices: boolean
}

/**
 * The single source of truth for the renderer/main boundary. Every entry is
 * `[argsTuple, result]`. Adding a channel here and nowhere else is a type
 * error on both sides — which is the point.
 */
export interface IpcContract {
  'app:info': [[], { name: string; version: string; homeDir: string }]

  'services:list': [[], ServiceDescriptor[]]
  'services:install': [[serviceId: string, version: string], void]
  'services:start': [[serviceId: string], ServiceDescriptor]
  'services:stop': [[serviceId: string], ServiceDescriptor]
  'services:updateConfig': [[serviceId: string, config: Partial<ServiceConfig>], ServiceDescriptor]
  'services:envBlock': [[serviceId: string], EnvBlock]
  'services:envBlocks': [[serviceIds: string[]], EnvBlock[]]

  'runtimes:list': [[], RuntimeDescriptor[]]
  'runtimes:available': [[runtimeId: RuntimeId], string[]]
  'runtimes:install': [[runtimeId: RuntimeId, version: string], void]
  'runtimes:uninstall': [[runtimeId: RuntimeId, version: string], void]
  'runtimes:resolve': [[runtimeId: RuntimeId, projectPath: string], ResolvedVersion]
  'runtimes:setDefault': [[runtimeId: RuntimeId, version: string], RuntimeDescriptor[]]

  'projects:list': [[], ProjectDescriptor[]]
  'projects:park': [[dir: string], ProjectDescriptor[]]
  'projects:link': [[dir: string], ProjectDescriptor]
  'projects:forget': [[projectId: string], void]
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
      }
    ],
    ProjectDescriptor
  ]
  'projects:chooseDirectory': [[], string | null]

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

  'tls:status': [[], { installed: boolean; caInstalled: boolean }]
  'dns:status': [[], { installed: boolean; configured: boolean }]

  'nginx:status': [[], NginxStatus]
  'nginx:reload': [[], void]
  /** Add Harbor's include to the system nginx.conf. Prompts for root. */
  'nginx:connect': [[], NginxStatus]
  'nginx:disconnect': [[], NginxStatus]
}

export type IpcChannel = keyof IpcContract
export type IpcArgs<C extends IpcChannel> = IpcContract[C][0]
export type IpcResult<C extends IpcChannel> = IpcContract[C][1]

/** Main → renderer pushes. */
export interface IpcEvents {
  'log:line': LogLine
  'service:changed': ServiceDescriptor
  'project:changed': ProjectDescriptor
  'process:changed': ProcessHandle
  'usage:sample': ResourceUsage[]
}

export type IpcEventName = keyof IpcEvents

/** Shape exposed on `window.harbor` by the preload bridge. */
export interface HarborBridge {
  invoke<C extends IpcChannel>(channel: C, ...args: IpcArgs<C>): Promise<IpcResult<C>>
  on<E extends IpcEventName>(event: E, listener: (payload: IpcEvents[E]) => void): () => void
}

import type { EnvBlock, ServiceConfig, ServiceDescriptor } from './service.js'
import type { RuntimeDescriptor, ResolvedVersion, RuntimeId } from './runtime.js'
import type { ProjectDescriptor, ProjectTypeId } from './project.js'
import type { ProcessHandle, ResourceUsage } from './process.js'
import type { LogLine, LogQuery } from './logs.js'
import type { AnalysisResult } from './intelligence.js'

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

  'nginx:status': [[], { installed: boolean; running: boolean; configPath: string | null }]
  'nginx:reload': [[], void]
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

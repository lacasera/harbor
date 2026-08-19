import { EventEmitter } from 'node:events'
import { existsSync, statSync, watch, type FSWatcher } from 'node:fs'
import { join } from 'node:path'
import type { AnalysisResult, ProjectAnalyzer } from '../../shared/intelligence.js'
import type { Project } from '../../shared/project.js'
import { EloquentErdAnalyzer } from './eloquent-erd.js'
import { ComposerDepsAnalyzer, NodeDepsAnalyzer } from './deps.js'
import { toClassDiagram, toErDiagram } from './mermaid.js'

interface CacheEntry {
  results: AnalysisResult[]
  /** source path → mtimeMs at analysis time. */
  fingerprint: Map<string, number>
}

/**
 * Static analysis, categorically separate from the runtime management the rest
 * of the app does. Always on-demand and cached — parking a project must never
 * block on parsing it.
 */
/** Directories and manifests whose changes can alter an analysis result. */
const WATCHED = ['app', 'src', 'database', 'composer.json', 'package.json']

export class CodeIntelligence extends EventEmitter {
  private readonly analyzers: ProjectAnalyzer[] = []
  private readonly cache = new Map<string, CacheEntry>()
  private readonly watchers = new Map<string, FSWatcher[]>()
  private readonly debounces = new Map<string, NodeJS.Timeout>()

  register(analyzer: ProjectAnalyzer): void {
    this.analyzers.push(analyzer)
  }

  async analyze(project: Project, force = false): Promise<AnalysisResult[]> {
    const cached = this.cache.get(project.id)
    if (!force && cached && this.isFresh(cached)) return cached.results

    const applicable = this.analyzers.filter((a) => a.supports(project))
    const results = await Promise.all(
      applicable.map((a) =>
        a.analyze(project.path).catch(
          (err: Error): AnalysisResult => ({
            analyzerId: a.id,
            generatedAt: Date.now(),
            entities: [],
            relations: [],
            dependencies: { nodes: [], edges: [] },
            sources: [],
            warnings: [`${a.displayName} failed: ${err.message}`]
          })
        )
      )
    )

    this.cache.set(project.id, { results, fingerprint: fingerprintOf(results) })
    this.watchProject(project)
    return results
  }

  invalidate(projectId: string): void {
    this.cache.delete(projectId)
  }

  /**
   * The mtime fingerprint only invalidates when someone asks again, so an open
   * Insights tab would show a stale diagram indefinitely. Watching the sources
   * lets the main process tell the renderer to re-analyze.
   */
  private watchProject(project: Project): void {
    if (this.watchers.has(project.id)) return

    const watchers: FSWatcher[] = []
    for (const entry of WATCHED) {
      const target = join(project.path, entry)
      if (!existsSync(target)) continue
      try {
        watchers.push(
          watch(target, { recursive: true }, () => this.onSourceChanged(project.id))
        )
      } catch {
        // A directory we cannot watch is not worth failing the analysis over.
      }
    }
    if (watchers.length) this.watchers.set(project.id, watchers)
  }

  /** Editors write in bursts; one save should not mean twenty re-analyses. */
  private onSourceChanged(projectId: string): void {
    clearTimeout(this.debounces.get(projectId))
    this.debounces.set(
      projectId,
      setTimeout(() => {
        this.debounces.delete(projectId)
        this.cache.delete(projectId)
        this.emit('invalidated', projectId)
      }, 750)
    )
  }

  unwatch(projectId: string): void {
    for (const watcher of this.watchers.get(projectId) ?? []) watcher.close()
    this.watchers.delete(projectId)
    clearTimeout(this.debounces.get(projectId))
    this.debounces.delete(projectId)
    this.cache.delete(projectId)
  }

  stopAll(): void {
    for (const id of [...this.watchers.keys()]) this.unwatch(id)
  }

  mermaid(results: AnalysisResult[], kind: 'erDiagram' | 'classDiagram'): string {
    return kind === 'erDiagram' ? toErDiagram(results) : toClassDiagram(results)
  }

  private isFresh(entry: CacheEntry): boolean {
    for (const [path, mtime] of entry.fingerprint) {
      try {
        if (statSync(path).mtimeMs !== mtime) return false
      } catch {
        return false
      }
    }
    return true
  }
}

function fingerprintOf(results: AnalysisResult[]): Map<string, number> {
  const map = new Map<string, number>()
  for (const result of results) {
    for (const path of result.sources) {
      if (!existsSync(path)) continue
      try {
        map.set(path, statSync(path).mtimeMs)
      } catch {
        /* skip unreadable source */
      }
    }
  }
  return map
}

export function createCodeIntelligence(): CodeIntelligence {
  const intel = new CodeIntelligence()
  intel.register(new EloquentErdAnalyzer())
  intel.register(new NodeDepsAnalyzer())
  intel.register(new ComposerDepsAnalyzer())
  return intel
}

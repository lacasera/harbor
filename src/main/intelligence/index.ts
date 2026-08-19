import { existsSync, statSync } from 'node:fs'
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
export class CodeIntelligence {
  private readonly analyzers: ProjectAnalyzer[] = []
  private readonly cache = new Map<string, CacheEntry>()

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
    return results
  }

  invalidate(projectId: string): void {
    this.cache.delete(projectId)
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

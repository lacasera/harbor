import { existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import type {
  AnalysisResult,
  DependencyEdge,
  DependencyNode,
  ProjectAnalyzer
} from '../../shared/intelligence.js'
import type { Project } from '../../shared/project.js'

function emptyResult(analyzerId: string): AnalysisResult {
  return {
    analyzerId,
    generatedAt: Date.now(),
    entities: [],
    relations: [],
    dependencies: { nodes: [], edges: [] },
    sources: [],
    warnings: []
  }
}

/** package.json + lockfile → direct and transitive dependency graph. */
export class NodeDepsAnalyzer implements ProjectAnalyzer {
  readonly id = 'node-deps'
  readonly displayName = 'npm dependencies'

  supports(project: Project): boolean {
    return existsSync(join(project.path, 'package.json'))
  }

  async analyze(dir: string): Promise<AnalysisResult> {
    const result = emptyResult(this.id)
    const pkgPath = join(dir, 'package.json')
    const pkg = JSON.parse(await readFile(pkgPath, 'utf8')) as {
      name?: string
      version?: string
      dependencies?: Record<string, string>
      devDependencies?: Record<string, string>
    }
    result.sources.push(pkgPath)

    const rootId = pkg.name ?? 'project'
    const nodes: DependencyNode[] = [
      { id: rootId, name: rootId, version: pkg.version ?? '0.0.0', direct: true }
    ]
    const edges: DependencyEdge[] = []

    for (const [name, range] of Object.entries({
      ...(pkg.dependencies ?? {}),
      ...(pkg.devDependencies ?? {})
    })) {
      nodes.push({ id: name, name, version: range, direct: true })
      edges.push({ from: rootId, to: name })
    }

    // Transitive edges come from the lockfile; without one we only know direct
    // deps, and we say so rather than pretending the graph is complete.
    const lock = join(dir, 'package-lock.json')
    if (existsSync(lock)) {
      result.sources.push(lock)
      try {
        const parsed = JSON.parse(await readFile(lock, 'utf8')) as {
          packages?: Record<string, { version?: string; dependencies?: Record<string, string> }>
        }
        const known = new Set(nodes.map((n) => n.id))
        for (const [path, entry] of Object.entries(parsed.packages ?? {})) {
          if (!path.startsWith('node_modules/')) continue
          const name = path.slice('node_modules/'.length)
          if (!known.has(name)) {
            nodes.push({ id: name, name, version: entry.version ?? '', direct: false })
            known.add(name)
          }
          for (const dep of Object.keys(entry.dependencies ?? {})) {
            edges.push({ from: name, to: dep })
          }
        }
      } catch {
        result.warnings.push('package-lock.json could not be parsed; showing direct deps only')
      }
    } else {
      result.warnings.push('No package-lock.json — transitive dependencies are not shown')
    }

    result.dependencies = { nodes, edges }
    return result
  }
}

/** composer.json + composer.lock → dependency graph. */
export class ComposerDepsAnalyzer implements ProjectAnalyzer {
  readonly id = 'composer-deps'
  readonly displayName = 'Composer dependencies'

  supports(project: Project): boolean {
    return existsSync(join(project.path, 'composer.json'))
  }

  async analyze(dir: string): Promise<AnalysisResult> {
    const result = emptyResult(this.id)
    const jsonPath = join(dir, 'composer.json')
    const json = JSON.parse(await readFile(jsonPath, 'utf8')) as {
      name?: string
      require?: Record<string, string>
      'require-dev'?: Record<string, string>
    }
    result.sources.push(jsonPath)

    const rootId = json.name ?? 'project'
    const nodes: DependencyNode[] = [{ id: rootId, name: rootId, version: 'dev', direct: true }]
    const edges: DependencyEdge[] = []

    const isPackage = (name: string): boolean => name.includes('/')
    for (const name of Object.keys({ ...(json.require ?? {}), ...(json['require-dev'] ?? {}) })) {
      // Skip platform requirements like "php" and "ext-mbstring".
      if (!isPackage(name)) continue
      nodes.push({ id: name, name, version: json.require?.[name] ?? '', direct: true })
      edges.push({ from: rootId, to: name })
    }

    const lock = join(dir, 'composer.lock')
    if (existsSync(lock)) {
      result.sources.push(lock)
      try {
        const parsed = JSON.parse(await readFile(lock, 'utf8')) as {
          packages?: Array<{ name: string; version: string; require?: Record<string, string> }>
        }
        const known = new Set(nodes.map((n) => n.id))
        for (const entry of parsed.packages ?? []) {
          if (!known.has(entry.name)) {
            nodes.push({ id: entry.name, name: entry.name, version: entry.version, direct: false })
            known.add(entry.name)
          }
          for (const dep of Object.keys(entry.require ?? {})) {
            if (isPackage(dep)) edges.push({ from: entry.name, to: dep })
          }
        }
      } catch {
        result.warnings.push('composer.lock could not be parsed; showing direct deps only')
      }
    } else {
      result.warnings.push('No composer.lock — transitive dependencies are not shown')
    }

    result.dependencies = { nodes, edges }
    return result
  }
}

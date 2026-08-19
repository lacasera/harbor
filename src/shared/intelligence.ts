import type { Project } from './project.js'

export interface EntityField {
  name: string
  type: string
  nullable?: boolean
  primary?: boolean
}

export interface Entity {
  id: string
  name: string
  /** Backing table/collection, when known. */
  table?: string
  fields: EntityField[]
  file?: string
}

export type RelationKind = 'has-one' | 'has-many' | 'belongs-to' | 'many-to-many'

export interface Relation {
  from: string
  to: string
  kind: RelationKind
  label?: string
}

export interface DependencyNode {
  id: string
  name: string
  version: string
  direct: boolean
}

export interface DependencyEdge {
  from: string
  to: string
}

/** The normalized graph every analyzer emits. The renderer only draws this. */
export interface AnalysisResult {
  analyzerId: string
  generatedAt: number
  entities: Entity[]
  relations: Relation[]
  dependencies: { nodes: DependencyNode[]; edges: DependencyEdge[] }
  /** Files whose mtime invalidates this result. */
  sources: string[]
  warnings: string[]
}

export interface ProjectAnalyzer {
  id: string
  displayName: string
  supports(project: Project): boolean
  analyze(dir: string): Promise<AnalysisResult>
}

export type DiagramKind = 'erDiagram' | 'classDiagram' | 'flowchart'

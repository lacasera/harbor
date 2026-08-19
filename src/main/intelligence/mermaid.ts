import type { AnalysisResult } from '../../shared/intelligence.js'

const ARROWS: Record<string, string> = {
  'has-one': '||--||',
  'has-many': '||--o{',
  'belongs-to': '}o--||',
  'many-to-many': '}o--o{'
}

/**
 * Analyzers emit the normalized graph; this converts it to Mermaid for the
 * renderer. Keeping the conversion here means a new analyzer gets diagrams for
 * free and the renderer never learns about analyzer internals.
 */
export function toErDiagram(results: AnalysisResult[]): string {
  const lines = ['erDiagram']
  const entities = results.flatMap((r) => r.entities)
  const relations = results.flatMap((r) => r.relations)
  const known = new Set(entities.map((e) => e.id))

  for (const entity of entities) {
    lines.push(`    ${entity.name} {`)
    for (const field of entity.fields) {
      const flags = [field.primary ? 'PK' : '', field.nullable ? '"nullable"' : '']
        .filter(Boolean)
        .join(' ')
      lines.push(`        ${sanitize(field.type)} ${sanitize(field.name)}${flags ? ` ${flags}` : ''}`)
    }
    lines.push('    }')
  }

  for (const rel of relations) {
    // Skip dangling edges — a relation to a model we never parsed would render
    // as a phantom entity.
    if (!known.has(rel.from) || !known.has(rel.to)) continue
    lines.push(`    ${rel.from} ${ARROWS[rel.kind] ?? '||--o{'} ${rel.to} : "${rel.label ?? ''}"`)
  }

  return lines.join('\n')
}

export function toClassDiagram(results: AnalysisResult[]): string {
  const lines = ['classDiagram']
  for (const entity of results.flatMap((r) => r.entities)) {
    lines.push(`    class ${entity.name} {`)
    for (const field of entity.fields) {
      lines.push(`        +${sanitize(field.type)} ${sanitize(field.name)}`)
    }
    lines.push('    }')
  }
  for (const rel of results.flatMap((r) => r.relations)) {
    lines.push(`    ${rel.from} --> ${rel.to} : ${rel.label ?? rel.kind}`)
  }
  return lines.join('\n')
}

export function toDependencyFlowchart(results: AnalysisResult[]): string {
  const lines = ['flowchart LR']
  for (const result of results) {
    for (const node of result.dependencies.nodes) {
      if (!node.direct) continue
      lines.push(`    ${idOf(node.id)}["${node.name}"]`)
    }
    for (const edge of result.dependencies.edges) {
      lines.push(`    ${idOf(edge.from)} --> ${idOf(edge.to)}`)
    }
  }
  return lines.join('\n')
}

function idOf(raw: string): string {
  return raw.replace(/[^a-zA-Z0-9]/g, '_')
}

function sanitize(raw: string): string {
  return raw.replace(/[^a-zA-Z0-9_]/g, '_')
}

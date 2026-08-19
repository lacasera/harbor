import { existsSync, readdirSync, statSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import type {
  AnalysisResult,
  Entity,
  EntityField,
  ProjectAnalyzer,
  Relation,
  RelationKind
} from '../../shared/intelligence.js'
import type { Project } from '../../shared/project.js'

const RELATION_KINDS: Record<string, RelationKind> = {
  OneToOne: 'has-one',
  OneToMany: 'has-many',
  ManyToOne: 'belongs-to',
  ManyToMany: 'many-to-many'
}

/**
 * Doctrine entities → the same normalized graph the Eloquent analyzer emits,
 * so the ERD, UML and Mermaid views work for Symfony projects without knowing
 * anything about Doctrine.
 *
 * Both mapping styles are read: PHP 8 attributes (`#[ORM\Column]`), which
 * modern Symfony uses, and the docblock annotations (`@ORM\Column`) still
 * common in older codebases.
 *
 * Parsing is line-based rather than one large regex: mapping metadata sits on
 * the lines *above* the property it describes, so accumulating pending
 * attributes and flushing them at the property declaration is both simpler and
 * more robust than trying to match the pair in one pattern.
 */
export class DoctrineErdAnalyzer implements ProjectAnalyzer {
  readonly id = 'doctrine-erd'
  readonly displayName = 'Doctrine entities & relationships'

  supports(project: Project): boolean {
    return (
      project.typeId === 'php' &&
      (existsSync(join(project.path, 'bin', 'console')) ||
        existsSync(join(project.path, 'symfony.lock')))
    )
  }

  async analyze(dir: string): Promise<AnalysisResult> {
    const warnings: string[] = []
    const sources: string[] = []
    const entities: Entity[] = []
    const relations: Relation[] = []

    const roots = [join(dir, 'src', 'Entity'), join(dir, 'src'), join(dir, 'lib')].filter((d) =>
      existsSync(d)
    )
    const files = [...new Set(roots.flatMap((d) => phpFilesIn(d, 4)))]

    for (const file of files) {
      const src = await readFile(file, 'utf8')
      if (!/#\[ORM\\Entity|@ORM\\Entity/.test(src)) continue

      const name = src.match(/(?:^|\n)\s*(?:final\s+)?class\s+(\w+)/)?.[1]
      if (!name) continue
      sources.push(file)

      const parsed = parseEntity(name, src)
      entities.push({ id: name, name, table: parsed.table, fields: parsed.fields, file })
      relations.push(...parsed.relations)
      warnings.push(...parsed.warnings)
    }

    return {
      analyzerId: this.id,
      generatedAt: Date.now(),
      entities,
      relations,
      dependencies: { nodes: [], edges: [] },
      sources,
      warnings
    }
  }
}

interface ParsedEntity {
  table: string
  fields: EntityField[]
  relations: Relation[]
  warnings: string[]
}

export function parseEntity(className: string, src: string): ParsedEntity {
  const fields: EntityField[] = []
  const relations: Relation[] = []
  const warnings: string[] = []

  const table =
    src.match(/#\[ORM\\Table\([^)]*name:\s*['"]([^'"]+)['"]/)?.[1] ??
    src.match(/@ORM\\Table\([^)]*name\s*=\s*['"]([^'"]+)['"]/)?.[1] ??
    snakeCase(className)

  // Mapping metadata precedes the property it describes, so collect it and
  // flush when the property declaration arrives.
  let pending: string[] = []

  for (const raw of src.split('\n')) {
    const line = raw.trim()

    if (line.startsWith('#[') || line.startsWith('*') || line.startsWith('/**')) {
      pending.push(line)
      continue
    }

    const property = line.match(
      /(?:private|protected|public)\s+(?:readonly\s+)?(?:(\??[\w\\|]+)\s+)?\$(\w+)/
    )
    if (!property) {
      // Anything else ends the run of metadata; a blank line between an
      // attribute and its property is legal, so keep those.
      if (line !== '') pending = []
      continue
    }

    const [, phpType, propName] = property
    const meta = pending.join('\n')
    pending = []
    if (!propName) continue

    const relation = meta.match(/ORM\\(OneToOne|OneToMany|ManyToOne|ManyToMany)\s*\(/)
    if (relation?.[1]) {
      const kind = RELATION_KINDS[relation[1]] as RelationKind
      const target =
        meta.match(/targetEntity:\s*([\w\\]+)::class/)?.[1] ??
        meta.match(/targetEntity\s*=\s*['"]([\w\\]+)['"]/)?.[1]
      if (!target) {
        warnings.push(`${className}::$${propName} ${relation[1]} has no resolvable targetEntity`)
        continue
      }
      relations.push({
        from: className,
        // Doctrine allows a fully-qualified target; the graph keys on the
        // short class name, as the entity list does.
        to: target.split('\\').pop() as string,
        kind,
        label: propName
      })
      continue
    }

    if (!/ORM\\Column/.test(meta)) continue

    const columnName =
      meta.match(/ORM\\Column\([^)]*name:\s*['"]([^'"]+)['"]/)?.[1] ??
      meta.match(/ORM\\Column\([^)]*name\s*=\s*['"]([^'"]+)['"]/)?.[1] ??
      snakeCase(propName)

    fields.push({
      name: columnName,
      type: columnType(meta, phpType),
      primary: /ORM\\Id\b/.test(meta),
      nullable: /nullable:\s*true/.test(meta) || /nullable\s*=\s*true/.test(meta)
    })
  }

  return { table, fields, relations, warnings }
}

/** `type: Types::STRING`, `type="string"`, or the PHP type hint as a fallback. */
function columnType(meta: string, phpType: string | undefined): string {
  const constant = meta.match(/type:\s*Types::(\w+)/)?.[1]
  if (constant) return constant.toLowerCase()

  const literal =
    meta.match(/type:\s*['"](\w+)['"]/)?.[1] ?? meta.match(/type\s*=\s*['"](\w+)['"]/)?.[1]
  if (literal) return literal

  // `#[ORM\Column]` with no type is legal — Doctrine infers it from the PHP
  // type hint. Strip the leading `?` and any namespace so the diagram shows
  // `DateTimeImmutable`, not `\DateTimeImmutable`.
  const hint = (phpType ?? 'mixed').replace(/^\?/, '')
  return hint.split('\\').pop() ?? hint
}

export function snakeCase(value: string): string {
  return value
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1_$2')
    .toLowerCase()
}

function phpFilesIn(dir: string, depth: number): string[] {
  if (depth < 0 || !existsSync(dir)) return []
  const out: string[] = []
  for (const entry of readdirSync(dir)) {
    if (entry.startsWith('.') || entry === 'vendor' || entry === 'node_modules') continue
    const full = join(dir, entry)
    try {
      const stat = statSync(full)
      if (stat.isDirectory()) out.push(...phpFilesIn(full, depth - 1))
      else if (entry.endsWith('.php')) out.push(full)
    } catch {
      /* unreadable entry — skip */
    }
  }
  return out
}

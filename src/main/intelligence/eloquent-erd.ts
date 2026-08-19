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

/**
 * Eloquent models do not all extend `Model`. Laravel's own User extends
 * Authenticatable, pivots extend Pivot, and plenty of apps extend a project
 * base class. Missing these loses the most connected model in the app.
 */
const MODEL_BASES = [
  'Model',
  'Authenticatable',
  'Pivot',
  'MorphPivot',
  'BaseModel',
  'User'
]

const MODEL_CLASS = new RegExp(
  `class\\s+\\w+\\s+extends\\s+(?:[\\w\\\\]*\\\\)?(?:${MODEL_BASES.join('|')})\\b`
)

const RELATION_METHODS: Record<string, RelationKind> = {
  hasOne: 'has-one',
  hasMany: 'has-many',
  belongsTo: 'belongs-to',
  belongsToMany: 'many-to-many',
  hasOneThrough: 'has-one',
  hasManyThrough: 'has-many',
  morphOne: 'has-one',
  morphMany: 'has-many',
  morphTo: 'belongs-to'
}

/**
 * Regex-level parsing of Eloquent models and migrations. Deliberately not a
 * full PHP parser: the goal is a readable ERD, and a heuristic that covers the
 * conventional 95% beats a fragile AST pipeline we have to keep in sync with
 * PHP releases. Anything it can't read lands in `warnings`.
 */
export class EloquentErdAnalyzer implements ProjectAnalyzer {
  readonly id = 'laravel-eloquent'
  readonly displayName = 'Eloquent models & relationships'

  supports(project: Project): boolean {
    return project.typeId === 'php' && existsSync(join(project.path, 'artisan'))
  }

  async analyze(dir: string): Promise<AnalysisResult> {
    const warnings: string[] = []
    const sources: string[] = []
    const entities: Entity[] = []
    const relations: Relation[] = []

    // app/Models is reachable from both roots; without deduping, every model
    // there was parsed twice and emitted as two identical entities. The depth
    // covers domain-style layouts such as app/Domains/<Area>/Models.
    const modelDirs = [join(dir, 'app', 'Models'), join(dir, 'app')].filter((d) => existsSync(d))
    const modelFiles = [...new Set(modelDirs.flatMap((d) => phpFilesIn(d, 4)))]

    const columnsByTable = await this.parseMigrations(join(dir, 'database', 'migrations'), sources)

    for (const file of modelFiles) {
      const src = await readFile(file, 'utf8')
      if (!MODEL_CLASS.test(src)) continue

      const name = src.match(/class\s+(\w+)/)?.[1]
      if (!name) continue
      sources.push(file)

      const explicitTable = src.match(/protected\s+\$table\s*=\s*['"]([^'"]+)['"]/)?.[1]
      const table = explicitTable ?? tableize(name)

      const fields: EntityField[] = columnsByTable.get(table) ?? []
      if (!fields.length) {
        const fillable = src.match(/protected\s+\$fillable\s*=\s*\[([\s\S]*?)\]/)?.[1]
        if (fillable) {
          for (const col of fillable.matchAll(/['"]([^'"]+)['"]/g)) {
            fields.push({ name: col[1] as string, type: 'unknown' })
          }
        } else {
          warnings.push(`No migration or $fillable found for ${name}; columns unknown`)
        }
      }

      entities.push({ id: name, name, table, fields, file })

      for (const match of src.matchAll(
        /function\s+(\w+)\s*\([^)]*\)[^{]*\{[^}]*?\$this->(hasOne|hasMany|belongsToMany|belongsTo|hasOneThrough|hasManyThrough|morphOne|morphMany|morphTo)\s*\(\s*([^)]*)\)/g
      )) {
        const [, method, call, argsRaw] = match
        const kind = RELATION_METHODS[call as string]
        if (!kind) continue
        // morphTo() has no single target by design — the related model is
        // chosen at runtime from a *_type column. Reporting that as an
        // unresolved target would be wrong, and it was the bulk of the
        // warnings on real codebases.
        if (call === 'morphTo') continue

        const target = (argsRaw ?? '').match(/(\w+)::class/)?.[1]
        if (!target) {
          warnings.push(`${name}::${method}() target could not be resolved`)
          continue
        }
        relations.push({ from: name, to: target, kind, label: method })
      }
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

  private async parseMigrations(
    dir: string,
    sources: string[]
  ): Promise<Map<string, EntityField[]>> {
    const byTable = new Map<string, EntityField[]>()
    if (!existsSync(dir)) return byTable

    for (const file of phpFilesIn(dir, 1)) {
      const src = await readFile(file, 'utf8')
      sources.push(file)
      // `function (Blueprint $table): void {` is standard in modern Laravel;
      // requiring `)` to be followed directly by `{` skipped those tables
      // entirely and reported the model as having no columns.
      for (const create of src.matchAll(
        /Schema::create\s*\(\s*['"](\w+)['"][\s\S]*?function\s*\([^)]*\)\s*(?::\s*[\w\\|]+\s*)?\{([\s\S]*?)\n\s*\}\s*\)/g
      )) {
        const table = create[1] as string
        const body = create[2] ?? ''
        const fields = byTable.get(table) ?? []
        for (const col of body.matchAll(
          /\$table->(\w+)\s*\(\s*(?:['"](\w+)['"])?[^)]*\)([^;]*);/g
        )) {
          const [, type, colName, modifiers] = col
          if (type === 'id' || type === 'bigIncrements' || type === 'increments') {
            fields.push({ name: colName ?? 'id', type: 'bigint', primary: true })
            continue
          }
          if (type === 'timestamps') {
            fields.push({ name: 'created_at', type: 'timestamp', nullable: true })
            fields.push({ name: 'updated_at', type: 'timestamp', nullable: true })
            continue
          }
          if (!colName) continue
          fields.push({
            name: colName,
            type: type ?? 'unknown',
            nullable: (modifiers ?? '').includes('nullable()')
          })
        }
        byTable.set(table, fields)
      }
    }
    return byTable
  }
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

/** Laravel's convention: User → users, Category → categories. */
export function tableize(className: string): string {
  const snake = className
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1_$2')
    .toLowerCase()
  if (/(s|x|z|ch|sh)$/.test(snake)) return `${snake}es`
  if (/[^aeiou]y$/.test(snake)) return `${snake.slice(0, -1)}ies`
  return `${snake}s`
}

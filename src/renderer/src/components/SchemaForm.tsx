import { useMemo, useState } from 'react'
import type { JSONSchema } from '../../../shared/json-schema.js'
import type { FieldError } from '../../../shared/service.js'
import { Toggle } from './primitives.js'

/**
 * The entire settings UI for every service, generated from its configSchema.
 * The design specifies exactly five control types — text, number, select,
 * toggle, password — so a driver that needs a new control adds a `format` to
 * its schema rather than a component here.
 */

interface FieldSpec {
  key: string
  label: string
  description: string
  schema: JSONSchema
  section: string
}

/**
 * Group fields into the design's uppercase section bands.
 *
 * A driver's own `section` wins. The name-sniffing below is only a fallback for
 * schemas that declare nothing — it has no way to know what an unfamiliar field
 * is, and filing everything it doesn't recognise under "Storage" produced bands
 * that actively misinform.
 */
function sectionOf(key: string, schema: JSONSchema): string {
  if (schema.section) return schema.section
  if (schema.format === 'password' || /user|password|key|token|secret|region/i.test(key)) {
    return 'Access'
  }
  if (schema.format === 'port' || /port|host|bind|address/i.test(key)) return 'Network'
  if (schema.format === 'path' || schema.format === 'directory' || /dir|path|volume/i.test(key)) {
    return 'Storage'
  }
  return 'Settings'
}

function specsFor(schema: JSONSchema): FieldSpec[] {
  return Object.entries(schema.properties ?? {}).map(([key, prop]) => ({
    key,
    label: prop.title ?? key,
    description: prop.description ?? '',
    schema: prop,
    section: sectionOf(key, prop)
  }))
}

export function SchemaForm({
  schema,
  values,
  errors = [],
  onSave,
  onReset,
  busy,
  saveLabel = 'Save & restart'
}: {
  schema: JSONSchema
  values: Record<string, unknown>
  /** Validation failures from the last save, addressed per field. */
  errors?: FieldError[]
  onSave: (values: Record<string, unknown>) => void
  onReset: () => void
  busy?: boolean
  saveLabel?: string
}): React.JSX.Element {
  const [draft, setDraft] = useState<Record<string, unknown>>(values)
  const [revealed, setRevealed] = useState<Record<string, boolean>>({})
  const [showJson, setShowJson] = useState(false)

  const sections = useMemo(() => {
    const specs = specsFor(schema)
    // Known bands first, in the order you actually need them; anything a driver
    // named itself follows, and Advanced sinks to the bottom because it is the
    // escape hatch rather than the thing most people came for.
    const order = ['Network', 'Access', 'Storage', 'Settings']
    const grouped = new Map<string, FieldSpec[]>()
    for (const spec of specs) {
      const list = grouped.get(spec.section) ?? []
      list.push(spec)
      grouped.set(spec.section, list)
    }
    const rank = (name: string): number => {
      if (name === 'Advanced') return 1000
      const i = order.indexOf(name)
      return i === -1 ? 500 : i
    }
    return [...grouped.entries()].sort(([a], [b]) => rank(a) - rank(b))
  }, [schema])

  const dirty = useMemo(
    () => Object.keys(draft).some((k) => draft[k] !== values[k]),
    [draft, values]
  )

  const set = (key: string, value: unknown): void => setDraft((d) => ({ ...d, [key]: value }))
  const errorFor = (key: string): string | null =>
    errors.find((e) => e.field === key)?.message ?? null

  return (
    <div className="stack">
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        <div className="hstack">
          <span style={{ fontSize: 14, fontWeight: 600 }}>Configuration</span>
          <span className="pill mono">generated from schema</span>
        </div>
        <button
          type="button"
          className="back"
          style={{ color: 'var(--ac)' }}
          onClick={() => setShowJson((v) => !v)}
        >
          {showJson ? 'Hide JSON Schema' : 'View JSON Schema'}
        </button>
      </div>

      {showJson && <div className="schema-json">{JSON.stringify(schema, null, 2)}</div>}

      {sections.map(([name, fields]) => (
        <div key={name} className="card">
          <div className="section-label">{name}</div>
          {fields.map((field) => (
            <div key={field.key} className="row">
              <div>
                <div className="k" style={{ color: 'var(--tx)' }}>
                  {field.label}
                </div>
                {field.description && <div className="hint">{field.description}</div>}
              </div>
              <div>
                <div className="v">
                  <Control
                    field={field}
                    value={draft[field.key]}
                    invalid={Boolean(errorFor(field.key))}
                    revealed={Boolean(revealed[field.key])}
                    onReveal={() => setRevealed((r) => ({ ...r, [field.key]: !r[field.key] }))}
                    onChange={(v) => set(field.key, v)}
                  />
                </div>
                {errorFor(field.key) && (
                  <div className="field-error">
                    {field.label} {errorFor(field.key)}
                  </div>
                )}
              </div>
            </div>
          ))}
        </div>
      ))}

      <div className="hstack" style={{ gap: 10 }}>
        <button
          type="button"
          className="btn primary"
          disabled={busy}
          onClick={() => onSave(draft)}
        >
          {saveLabel}
        </button>
        <button
          type="button"
          className="btn"
          disabled={busy}
          onClick={() => {
            setDraft(values)
            onReset()
          }}
        >
          Reset to defaults
        </button>
        {errors.length > 0 ? (
          <span className="banner" style={{ color: 'var(--rd)' }}>
            <span className="dot sm" style={{ background: 'var(--rd)' }} />
            {errors.length} field{errors.length > 1 ? 's' : ''} need attention
          </span>
        ) : (
          dirty && (
            <span className="banner">
              <span className="dot sm" style={{ background: 'var(--am)' }} />
              unsaved changes — restart required
            </span>
          )
        )}
      </div>
    </div>
  )
}

function Control({
  field,
  value,
  invalid,
  revealed,
  onReveal,
  onChange
}: {
  field: FieldSpec
  value: unknown
  invalid: boolean
  revealed: boolean
  onReveal: () => void
  onChange: (value: unknown) => void
}): React.JSX.Element {
  const { schema } = field

  if (schema.type === 'boolean') {
    return <Toggle on={Boolean(value)} label={field.label} onChange={onChange} />
  }

  if (schema.enum?.length) {
    return (
      <select
        className="field-select"
        style={{ width: 200 }}
        value={String(value ?? '')}
        onChange={(e) => onChange(e.target.value)}
      >
        {schema.enum.map((option) => (
          <option key={String(option)} value={String(option)}>
            {String(option)}
          </option>
        ))}
      </select>
    )
  }

  if (schema.format === 'password') {
    const raw = String(value ?? '')
    return (
      <>
        <div
          className="field-input mono"
          style={{ width: 280, display: 'flex', alignItems: 'center', letterSpacing: '.04em' }}
        >
          {revealed ? raw : '•'.repeat(raw.length)}
        </div>
        <button type="button" className="btn xs" onClick={onReveal}>
          {revealed ? 'Hide' : 'Reveal'}
        </button>
      </>
    )
  }

  // Multi-line by nature: extra server flags, environment lines and a mounted
  // config file are all "one per line", and a single-line input turns them into
  // something you have to scroll horizontally to read.
  if (schema.format === 'textarea') {
    return (
      <textarea
        className={`field-input mono ${invalid ? 'invalid' : ''}`}
        style={{ width: 400, maxWidth: '100%', minHeight: 84, resize: 'vertical', padding: 8 }}
        value={String(value ?? '')}
        spellCheck={false}
        placeholder={schema.description ?? ''}
        onChange={(e) => onChange(e.target.value)}
      />
    )
  }

  const numeric = schema.type === 'integer' || schema.type === 'number'
  const pathLike = schema.format === 'path' || schema.format === 'directory'

  return (
    <>
      <input
        className={`field-input ${pathLike ? 'mono' : ''} ${invalid ? 'invalid' : ''}`}
        style={{ width: numeric ? 110 : pathLike ? 400 : 280, maxWidth: '100%' }}
        type={numeric ? 'number' : 'text'}
        value={String(value ?? '')}
        min={schema.minimum}
        max={schema.maximum}
        placeholder={schema.default !== undefined ? String(schema.default) : ''}
        onChange={(e) => onChange(numeric ? Number(e.target.value) : e.target.value)}
      />
      {numeric && <span className="small muted">integer</span>}
    </>
  )
}

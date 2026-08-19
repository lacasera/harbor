import { useState } from 'react'
import type { JSONSchema } from '../../../shared/json-schema.js'

interface Props {
  schema: JSONSchema
  values: Record<string, unknown>
  onSave: (values: Record<string, unknown>) => void
  disabled?: boolean
}

/**
 * Generates the whole settings form from a driver's configSchema. There is no
 * service-specific form anywhere in the app — if a service needs a new control,
 * it belongs in the schema (a new `format`), not here.
 */
export function ConfigForm({ schema, values, onSave, disabled }: Props): React.JSX.Element {
  const [draft, setDraft] = useState<Record<string, unknown>>(values)
  const properties = Object.entries(schema.properties ?? {})
  const required = new Set(schema.required ?? [])

  const set = (key: string, value: unknown): void => setDraft((d) => ({ ...d, [key]: value }))

  return (
    <form
      className="config-form"
      onSubmit={(e) => {
        e.preventDefault()
        onSave(draft)
      }}
    >
      {properties.map(([key, prop]) => (
        <label key={key} className="field">
          <span className="field-label">
            {prop.title ?? key}
            {required.has(key) && <em aria-hidden> *</em>}
          </span>
          <Control
            name={key}
            schema={prop}
            value={draft[key]}
            disabled={disabled}
            onChange={(v) => set(key, v)}
          />
          {prop.description && <small className="field-hint">{prop.description}</small>}
        </label>
      ))}
      <button type="submit" className="btn primary" disabled={disabled}>
        Save configuration
      </button>
    </form>
  )
}

function Control({
  name,
  schema,
  value,
  disabled,
  onChange
}: {
  name: string
  schema: JSONSchema
  value: unknown
  disabled?: boolean
  onChange: (value: unknown) => void
}): React.JSX.Element {
  if (schema.enum?.length) {
    return (
      <select
        name={name}
        value={String(value ?? '')}
        disabled={disabled}
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

  if (schema.type === 'boolean') {
    return (
      <input
        type="checkbox"
        name={name}
        checked={Boolean(value)}
        disabled={disabled}
        onChange={(e) => onChange(e.target.checked)}
      />
    )
  }

  const numeric = schema.type === 'integer' || schema.type === 'number'
  return (
    <input
      type={schema.format === 'password' ? 'password' : numeric ? 'number' : 'text'}
      name={name}
      value={String(value ?? '')}
      min={schema.minimum}
      max={schema.maximum}
      disabled={disabled}
      placeholder={schema.default !== undefined ? String(schema.default) : ''}
      onChange={(e) => onChange(numeric ? Number(e.target.value) : e.target.value)}
    />
  )
}

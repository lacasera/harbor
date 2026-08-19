/**
 * A deliberately small JSON Schema subset — enough to drive the config form
 * generator in the renderer without pulling a full schema type dependency
 * across the IPC boundary.
 */
export type JSONSchemaType = 'string' | 'number' | 'integer' | 'boolean' | 'object' | 'array'

export interface JSONSchema {
  type?: JSONSchemaType
  title?: string
  description?: string
  default?: unknown
  enum?: unknown[]
  /**
   * Which band this field appears under in the generated form. Declared by the
   * driver because only it knows what a field is FOR — the heuristic fallback
   * put "Binary log" and "Server ID" under Storage, which is not wrong so much
   * as meaningless.
   */
  section?: string
  /** UI hint: render as a password field, a directory picker, etc. */
  format?: 'password' | 'port' | 'path' | 'directory' | 'uri' | 'email' | 'textarea'
  minimum?: number
  maximum?: number
  minLength?: number
  maxLength?: number
  pattern?: string
  properties?: Record<string, JSONSchema>
  required?: string[]
  items?: JSONSchema
  additionalProperties?: boolean | JSONSchema
}

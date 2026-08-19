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
  /** UI hint: render as a password field, a directory picker, etc. */
  format?: 'password' | 'port' | 'path' | 'directory' | 'uri' | 'email'
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

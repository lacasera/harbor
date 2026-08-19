import Ajv, { type ErrorObject } from 'ajv'
import type { FieldError, ServiceDriver } from '../../shared/service.js'
import type { JSONSchema } from '../../shared/json-schema.js'

/**
 * The service catalogue: every driver, by id, and nothing else.
 *
 * It used to hold running config and health too, which is what made services
 * machine-wide singletons — one driver, one config, one status. Those now live
 * per instance in `ServiceInstances`, and what remains here is a lookup table
 * plus the schema helpers both sides need. Adding a service is still exactly
 * "register a driver".
 */
export class ServiceCatalogue {
  private readonly drivers = new Map<string, ServiceDriver>()

  register(driver: ServiceDriver): void {
    this.drivers.set(driver.id, driver)
  }

  has(id: string): boolean {
    return this.drivers.has(id)
  }

  get(id: string): ServiceDriver {
    const driver = this.drivers.get(id)
    if (!driver) throw new Error(`Unknown service: ${id}`)
    return driver
  }

  ids(): string[] {
    return [...this.drivers.keys()]
  }

  all(): ServiceDriver[] {
    return [...this.drivers.values()]
  }
}

/** `${key}` interpolation against the live config scope. */
export function interpolate(template: string, scope: Record<string, unknown>): string {
  return template.replace(/\$\{(\w+)\}/g, (match: string, key: string) => {
    // An absent key keeps its placeholder rather than collapsing to an empty
    // string. Collapsing made a typo in a driver's envHints indistinguishable
    // from a value that is deliberately blank — and blank is correct for
    // plenty of them: Mailpit wants MAIL_USERNAME= and Redis wants no password.
    if (!(key in scope)) return match
    const value = scope[key]
    return value === undefined || value === null ? '' : String(value)
  })
}

// One compiled instance: Ajv caches by schema object identity, and driver
// schemas are stable for the process lifetime.
const ajv = new Ajv({ allErrors: true, coerceTypes: true, useDefaults: false, strict: false })

// `format` in a driver schema is a UI hint — which control the form renders —
// not a validation rule. Registering them as always-valid documents that and
// stops Ajv warning about an unknown format on every compile.
for (const hint of ['password', 'port', 'path', 'directory', 'uri', 'email', 'textarea']) {
  ajv.addFormat(hint, () => true)
}

/** Schema violations, addressed to the field that caused each one. */
export function validate(schema: JSONSchema, values: Record<string, unknown>): FieldError[] {
  const check = ajv.compile(schema as object)
  if (check(values)) return []
  return (check.errors ?? []).map(toFieldError)
}

function toFieldError(error: ErrorObject): FieldError {
  // "must have required property 'port'" carries the field in params, not path.
  if (error.keyword === 'required') {
    const field = String((error.params as { missingProperty?: string }).missingProperty ?? '')
    return { field, message: 'is required' }
  }
  return {
    field: error.instancePath.replace(/^\//, ''),
    message: error.message ?? 'is invalid'
  }
}

export function defaultsFor(schema: JSONSchema): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const [key, prop] of Object.entries(schema.properties ?? {})) {
    if (prop.default !== undefined) out[key] = prop.default
  }
  return out
}

/** Schema fields that name a host port, so the allocator knows what to assign. */
export function portFields(schema: JSONSchema): string[] {
  return Object.entries(schema.properties ?? {})
    .filter(([, prop]) => prop.format === 'port')
    .map(([key]) => key)
}

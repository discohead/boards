// The subset of JSON Schema the org's block schemas use (org/schemas.ts): type, enum, const, anyOf,
// required, properties, additionalProperties, items, min/maxItems, min/maxLength, minimum and
// maximum, and format uri. The seat form checks a block with it before it sends, so what the board
// would refuse for its shape is said beside the field; the board still checks it on the write.
import { SEAT_SCHEMA, SEAT_SCHEMA_2 } from './schemas.ts'

type Schema = Record<string, any>
export type SchemaError = { path: string; message: string }

const typeOf = (value: unknown) => (value === null ? 'null' : Array.isArray(value) ? 'array' : typeof value === 'number' && Number.isInteger(value) ? 'integer' : typeof value)
const fits = (value: unknown, type: string) => type === typeOf(value) || (type === 'number' && typeof value === 'number')

export function check(schema: Schema, value: unknown, path = ''): SchemaError[] {
  const at = (message: string): SchemaError[] => [{ path, message }]
  if (schema.anyOf) {
    const each = (schema.anyOf as Schema[]).map((one) => check(one, value, path))
    return each.some((errors) => errors.length === 0) ? [] : at(describe(value) + " isn't one of the forms this takes")
  }
  if ('const' in schema && value !== schema.const) return at('must be ' + JSON.stringify(schema.const))
  if (schema.enum && !schema.enum.includes(value)) return at('must be one of ' + schema.enum.map((one: unknown) => JSON.stringify(one)).join(', '))
  if (schema.type && !fits(value, schema.type)) return at('must be ' + (schema.type === 'integer' ? 'a whole number' : schema.type === 'array' ? 'a list' : 'a ' + schema.type))
  const out: SchemaError[] = []
  if (typeof value === 'string') {
    if (schema.minLength !== undefined && [...value].length < schema.minLength) out.push(...at(schema.minLength === 1 ? "can't be empty" : 'needs at least ' + schema.minLength + ' characters'))
    if (schema.maxLength !== undefined && [...value].length > schema.maxLength) out.push(...at('is at most ' + schema.maxLength + ' characters'))
    if (schema.format === 'uri' && !/^[a-z][a-z0-9+.-]*:\S+$/i.test(value)) out.push(...at('must be a URL'))
  }
  if (typeof value === 'number') {
    if (schema.minimum !== undefined && value < schema.minimum) out.push(...at('is at least ' + schema.minimum))
    if (schema.maximum !== undefined && value > schema.maximum) out.push(...at('is at most ' + schema.maximum))
  }
  if (Array.isArray(value)) {
    if (schema.minItems !== undefined && value.length < schema.minItems) out.push(...at('needs at least ' + schema.minItems))
    if (schema.maxItems !== undefined && value.length > schema.maxItems) out.push(...at('holds at most ' + schema.maxItems))
    if (schema.items) value.forEach((item, i) => out.push(...check(schema.items, item, path + '[' + i + ']')))
  }
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    const record = value as Record<string, unknown>
    for (const key of schema.required ?? []) if (!(key in record)) out.push({ path: join(path, key), message: 'is required' })
    for (const [key, item] of Object.entries(record)) {
      const known = schema.properties?.[key]
      if (known) out.push(...check(known, item, join(path, key)))
      else if (schema.additionalProperties === false) out.push({ path: join(path, key), message: "isn't a field this takes" })
      else if (schema.additionalProperties && typeof schema.additionalProperties === 'object') out.push(...check(schema.additionalProperties, item, join(path, key)))
    }
  }
  return out
}

const join = (path: string, key: string) => (path ? path + '.' + key : key)
const describe = (value: unknown) => (typeof value === 'string' ? JSON.stringify(value) : typeOf(value))

/** A seat block against json#seat@1 or @2, as it'll be written: empty when the board would take its shape. */
export const checkSeatBlock = (block: unknown, version: 1 | 2 = 1) => check((version === 2 ? SEAT_SCHEMA_2 : SEAT_SCHEMA).schema, block)

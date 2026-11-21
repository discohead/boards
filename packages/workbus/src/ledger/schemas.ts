// Schemas: the registry blocks are checked against. Built-ins on every board, then the board's own,
// each name@version registered once and never changed. A definition is a small JSON Schema subset
// (checkDefinition); a block's data is checked against it on every write that carries one (checkValue).
import { WorkbusError, badRequest, forbidden, notFound } from '../errors.ts'
import { iso } from './core.ts'
import { at, grantAccess } from './grants.ts'
import { hooks, op, type Ctx } from './ops.ts'
import { findBlocks } from './text.ts'

const SCHEMA_ID = /^([a-z][a-z0-9._-]{0,79})@([1-9][0-9]{0,4})$/
const SCHEMAS_MAX = 500
const DEFINITION_BYTES = 32768
const NODES_MAX = 512
const DEPTH_MAX = 16
const SUBSCHEMAS_MAX = 64

type Json = null | boolean | number | string | Json[] | { [key: string]: Json }
type Schema = Record<string, unknown>
export type SchemaRecord = { id: string; name: string; version: number; description: string | null; schema: Schema; builtIn: boolean; by: string | null; at: string | null }

// -- built-ins ---------------------------------------------------------------------------------

const commitSha = { type: 'string', pattern: '^(?:[0-9a-f]{40}|[0-9a-f]{64})$', description: 'Full lowercase commit SHA' }

/** On every board, in this order; their names are reserved, and they may use pattern, which registered schemas can't. */
export const BUILT_INS: SchemaRecord[] = [
  {
    id: 'git-commit@1', name: 'git-commit', version: 1, builtIn: true, by: null, at: null,
    description: 'A Git commit, by its full SHA and the first line of its message.',
    schema: { type: 'object', additionalProperties: false, required: ['sha', 'title'], properties: { sha: commitSha, title: { type: 'string', minLength: 1, maxLength: 1024 } } },
  },
  {
    id: 'cloudflare-deployment@1', name: 'cloudflare-deployment', version: 1, builtIn: true, by: null, at: null,
    description: 'A Cloudflare Workers deployment, by its URL and optionally its version ID and the commit it was built from.',
    schema: {
      type: 'object', additionalProperties: false, required: ['url'],
      properties: { url: { type: 'string', format: 'uri', pattern: '^https://', maxLength: 2048 }, versionId: { type: 'string', format: 'uuid' }, gitSha: commitSha },
    },
  },
]
const RESERVED = new Set(BUILT_INS.map((schema) => schema.name))

// -- sameness ----------------------------------------------------------------------------------

/** JSON with every object's keys sorted (code-unit order): two definitions are the same when theirs are. */
export function canonical(value: unknown): string {
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']'
  if (value && typeof value === 'object') {
    const keys = Object.keys(value).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))
    return '{' + keys.map((key) => JSON.stringify(key) + ':' + canonical((value as Record<string, unknown>)[key])).join(',') + '}'
  }
  return JSON.stringify(value) ?? 'null'
}

// -- checkDefinition -----------------------------------------------------------------------------

const TYPES = ['object', 'array', 'string', 'number', 'integer', 'boolean', 'null']
const FORMATS = ['date-time', 'date', 'time', 'email', 'uri', 'uuid', 'hostname', 'ipv4', 'ipv6']
const isObject = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value)
const isSchema = (value: unknown) => isObject(value) || typeof value === 'boolean'
const wholeNumber = (value: unknown) => typeof value === 'number' && Number.isInteger(value) && value >= 0
const finite = (value: unknown) => typeof value === 'number' && Number.isFinite(value)

type Shape = { takes: string; ok: (value: unknown) => boolean }
const string: Shape = { takes: 'a string', ok: (value) => typeof value === 'string' }
const count: Shape = { takes: 'a whole number, 0 or more', ok: wholeNumber }
const number: Shape = { takes: 'a number', ok: finite }
const schemas: Shape = { takes: 'a list of at least one schema', ok: (value) => Array.isArray(value) && value.length > 0 && value.every(isSchema) }

const KEYWORDS: Record<string, Shape> = {
  $schema: string,
  title: string,
  description: string,
  type: {
    takes: 'object, array, string, number, integer, boolean, or null, or a list of them',
    ok: (value) => (typeof value === 'string' ? TYPES.includes(value) : Array.isArray(value) && value.length > 0 && new Set(value).size === value.length && value.every((item) => typeof item === 'string' && TYPES.includes(item))),
  },
  properties: { takes: 'an object of schemas, by property', ok: (value) => isObject(value) && Object.values(value).every(isSchema) },
  required: { takes: 'a list of property names, each once', ok: (value) => Array.isArray(value) && value.every((item) => typeof item === 'string') && new Set(value).size === value.length },
  additionalProperties: { takes: 'a schema, or true or false', ok: isSchema },
  items: { takes: 'one schema for every item', ok: isSchema },
  minItems: count,
  maxItems: count,
  minLength: count,
  maxLength: count,
  minimum: number,
  maximum: number,
  exclusiveMinimum: number,
  exclusiveMaximum: number,
  multipleOf: { takes: 'a number above 0', ok: (value) => finite(value) && (value as number) > 0 },
  enum: { takes: 'a list of at least one value', ok: (value) => Array.isArray(value) && value.length > 0 },
  const: { takes: 'any value', ok: () => true },
  oneOf: schemas,
  anyOf: schemas,
  allOf: schemas,
  not: { takes: 'a schema', ok: isSchema },
  format: { takes: 'one of ' + FORMATS.join(', '), ok: (value) => typeof value === 'string' && FORMATS.includes(value) },
}

const storableText = (value: string) => !value.includes('\u0000') && value.isWellFormed()
const invalidSchema = (message: string) => new WorkbusError(400, 'invalid_schema', message)

/** A definition the board can check values against, or 400 invalid_schema with its first problem. */
export function checkDefinition(schema: unknown): void {
  if (!isObject(schema) || schema.type !== 'object') throw invalidSchema('a schema describes a JSON object: give it "type": "object"')
  if (new TextEncoder().encode(JSON.stringify(schema)).length > DEFINITION_BYTES) throw invalidSchema('a schema is at most 32768 bytes of JSON')
  // Every value is a node; text holds no NUL or lone surrogate.
  let nodes = 0
  let badText = false
  const visit = (value: unknown, depth: number) => {
    nodes++
    if (nodes > NODES_MAX || depth > DEPTH_MAX) throw invalidSchema('a schema has at most 512 nodes and 16 levels')
    if (typeof value === 'string') badText ||= !storableText(value)
    else if (Array.isArray(value)) for (const item of value) visit(item, depth + 1)
    else if (isObject(value))
      for (const [key, item] of Object.entries(value)) {
        badText ||= !storableText(key)
        visit(item, depth + 1)
      }
  }
  visit(schema, 0)
  // Every object in a schema position is a subschema; each keyword is one the board checks.
  let subschemas = 0
  const problems: string[] = []
  const walk = (node: unknown, path: string) => {
    if (!isObject(node)) return
    subschemas++
    for (const [keyword, value] of Object.entries(node)) {
      const shape = KEYWORDS[keyword]
      if (!shape) {
        problems.push('schemas don\'t take "' + keyword + '"' + (path ? ' (at ' + path + ')' : '') + ': no references, patterns, uniqueItems, or keywords of your own')
        continue
      }
      if (!shape.ok(value)) {
        problems.push('"' + keyword + '"' + (path ? ' at ' + path : '') + ' takes ' + shape.takes)
        continue
      }
      if (keyword === 'properties') for (const [name, child] of Object.entries(value as Record<string, unknown>)) walk(child, path + '/properties/' + name)
      else if (keyword === 'additionalProperties' || keyword === 'items' || keyword === 'not') walk(value, path + '/' + keyword)
      else if (keyword === 'oneOf' || keyword === 'anyOf' || keyword === 'allOf') (value as unknown[]).forEach((child, i) => walk(child, path + '/' + keyword + '/' + i))
    }
  }
  walk(schema, '')
  if (subschemas > SUBSCHEMAS_MAX) throw invalidSchema('a schema has at most 64 subschemas')
  if (badText) throw invalidSchema('a schema has a NUL character or a lone surrogate in its text')
  if (problems.length) throw invalidSchema(problems[0]!)
}

// -- checkValue --------------------------------------------------------------------------------

const DATE = /^(\d\d\d\d)-(\d\d)-(\d\d)$/
const DAYS = [0, 31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31]
const TIME = /^(\d\d):(\d\d):(\d\d)(\.\d+)?(z|[+-]\d\d(?::?\d\d)?)?$/i
const leap = (year: number) => year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0)
function isDate(value: string) {
  const found = DATE.exec(value)
  if (!found) return false
  const year = Number(found[1])
  const month = Number(found[2])
  const day = Number(found[3])
  return month >= 1 && month <= 12 && day >= 1 && day <= (month === 2 && leap(year) ? 29 : DAYS[month]!)
}
function isTime(value: string) {
  const found = TIME.exec(value)
  if (!found) return false
  const hour = Number(found[1])
  const minute = Number(found[2])
  const second = Number(found[3])
  return (hour <= 23 && minute <= 59 && second <= 59) || (hour === 23 && minute === 59 && second === 60)
}
function isIpv6(value: string) {
  if (!/^[0-9a-f:.]+$/i.test(value) || !value.includes(':')) return false
  try {
    return new URL('http://[' + value + ']/').hostname.length > 2
  } catch {
    return false
  }
}
const FORMAT_CHECKS: Record<string, (value: string) => boolean> = {
  date: isDate,
  time: isTime,
  'date-time': (value) => {
    const parts = value.split(/t|\s/i)
    return parts.length === 2 && isDate(parts[0]!) && isTime(parts[1]!)
  },
  email: (value) => /^[a-z0-9!#$%&'*+/=?^_\u0060{|}~-]+(?:\.[a-z0-9!#$%&'*+/=?^_\u0060{|}~-]+)*@(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/i.test(value),
  uri: (value) => /[/:]/.test(value) && /^[a-z][a-z0-9+\-.]*:[^\s"<>\\^\u0060{|}]*$/i.test(value) && URL.canParse(value),
  uuid: (value) => /^(?:urn:uuid:)?[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i.test(value),
  hostname: (value) => /^(?=.{1,253}\.?$)[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[-0-9a-z]{0,61}[0-9a-z])?)*\.?$/i.test(value),
  ipv4: (value) => /^(?:(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)\.){3}(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)$/.test(value),
  ipv6: isIpv6,
}

const typeOf = (value: unknown) => (value === null ? 'null' : Array.isArray(value) ? 'array' : typeof value === 'number' ? (Number.isInteger(value) ? 'integer' : 'number') : typeof value)
const TYPE_PHRASE: Record<string, string> = { string: 'a string', object: 'an object', integer: 'an integer', array: 'an array', number: 'a number', boolean: 'a boolean', null: 'null' }
const article = (word: string) => (/^[aeiu]/.test(word) ? 'an ' : 'a ') + word
const cut = (value: unknown) => {
  const text = JSON.stringify(value) ?? 'null'
  return text.length > 40 ? text.slice(0, 40) + '…' : text
}
function oneOfPhrase(values: unknown[]): string {
  const shown = values.map(cut)
  if (shown.length === 1) return shown[0]!
  if (shown.length === 2) return shown[0] + ' or ' + shown[1]
  if (shown.length <= 5) return shown.slice(0, -1).join(', ') + ', or ' + shown.at(-1)
  return 'one of ' + shown.slice(0, 6).join(', ') + (shown.length > 6 ? ', …' : '')
}
const child = (field: string, name: string) => (field === 'it' ? name : field + '.' + name)

/** The first problem with a value against a schema, said of its field; null when it matches. */
export function checkValue(schema: unknown, value: unknown, field = 'it'): string | null {
  if (schema === true) return null
  if (schema === false) return field + " isn't allowed"
  if (!isObject(schema)) return null
  const kind = typeOf(value)
  if (schema.type !== undefined) {
    const types = Array.isArray(schema.type) ? (schema.type as string[]) : [schema.type as string]
    if (!types.some((type) => type === kind || (type === 'number' && kind === 'integer'))) return field + ' must be ' + types.map((type) => TYPE_PHRASE[type] ?? type).join(' or ')
  }
  if ('const' in schema && canonical(schema.const) !== canonical(value)) return field + ' must be ' + cut(schema.const)
  if (Array.isArray(schema.enum) && !schema.enum.some((option) => canonical(option) === canonical(value))) return field + ' must be ' + oneOfPhrase(schema.enum)
  if (typeof value === 'string') {
    const length = [...value].length
    if (typeof schema.minLength === 'number' && length < schema.minLength) return field + ' must be at least ' + schema.minLength + ' characters'
    if (typeof schema.maxLength === 'number' && length > schema.maxLength) return field + ' must be at most ' + schema.maxLength + ' characters'
    if (typeof schema.format === 'string' && FORMAT_CHECKS[schema.format] && !FORMAT_CHECKS[schema.format]!(value)) return field + ' must be ' + article(schema.format)
    if (typeof schema.pattern === 'string' && !new RegExp(schema.pattern, 'u').test(value)) return field + ' must match ' + schema.pattern
  }
  if (typeof value === 'number') {
    if (typeof schema.minimum === 'number' && value < schema.minimum) return field + ' must be at least ' + schema.minimum
    if (typeof schema.maximum === 'number' && value > schema.maximum) return field + ' must be at most ' + schema.maximum
    if (typeof schema.exclusiveMinimum === 'number' && value <= schema.exclusiveMinimum) return field + ' must be above ' + schema.exclusiveMinimum
    if (typeof schema.exclusiveMaximum === 'number' && value >= schema.exclusiveMaximum) return field + ' must be below ' + schema.exclusiveMaximum
    if (typeof schema.multipleOf === 'number' && !Number.isInteger(value / schema.multipleOf)) return field + ' must be a multiple of ' + schema.multipleOf
  }
  if (Array.isArray(value)) {
    if (typeof schema.minItems === 'number' && value.length < schema.minItems) return field + ' must have at least ' + schema.minItems + ' items'
    if (typeof schema.maxItems === 'number' && value.length > schema.maxItems) return field + ' must have at most ' + schema.maxItems + ' items'
    if (schema.items !== undefined)
      for (let i = 0; i < value.length; i++) {
        const items = schema.items
        const itemSchema = Array.isArray(items) ? (i < items.length ? items[i] : true) : items
        const problem = checkValue(itemSchema, value[i], field + '[' + i + ']')
        if (problem) return problem
      }
  }
  if (isObject(value)) {
    for (const name of Array.isArray(schema.required) ? (schema.required as string[]) : []) if (!Object.hasOwn(value, name)) return child(field, name) + ' is missing'
    const properties = isObject(schema.properties) ? schema.properties : {}
    for (const [name, item] of Object.entries(value)) {
      if (Object.hasOwn(properties, name)) {
        const problem = checkValue(properties[name], item, child(field, name))
        if (problem) return problem
      } else if (schema.additionalProperties === false) return child(field, name) + " isn't one of its fields"
      else if (schema.additionalProperties !== undefined) {
        const problem = checkValue(schema.additionalProperties, item, child(field, name))
        if (problem) return problem
      }
    }
  }
  if (Array.isArray(schema.allOf))
    for (const option of schema.allOf) {
      const problem = checkValue(option, value, field)
      if (problem) return problem
    }
  for (const keyword of ['anyOf', 'oneOf'] as const) {
    const options = schema[keyword]
    if (!Array.isArray(options)) continue
    const problems = options.map((option) => checkValue(option, value, field))
    const passed = problems.filter((problem) => problem === null).length
    if (passed === 0) return options.length === 1 ? problems[0]! : field + ' matches none of the ' + options.length + ' it can be: ' + [...new Set(problems)].slice(0, 4).join('; ')
    if (keyword === 'oneOf' && passed > 1) return field + ' matches ' + passed + ' of the ' + options.length + ' it can be, and must match one'
  }
  if (schema.not !== undefined && checkValue(schema.not, value, field) === null) return field + ' matches what it must not'
  return null
}

// -- the registry ------------------------------------------------------------------------------

type Row = { id: string; name: string; version: number; description: string | null; definition: string; by: string; at: number }
const viewOf = (row: Row): SchemaRecord => ({ id: row.id, name: row.name, version: row.version, description: row.description, schema: JSON.parse(row.definition) as Schema, builtIn: false, by: row.by, at: iso(row.at) })

export function findSchema(ctx: Pick<Ctx, 'sql'>, id: string): SchemaRecord | null {
  const builtIn = BUILT_INS.find((schema) => schema.id === id)
  if (builtIn) return builtIn
  const row = ctx.sql.one<Row>('select * from schemas where id = ?', id)
  return row ? viewOf(row) : null
}

/** Checks a text's blocks against the registry: 400 invalid_block or schema_not_found, before anything is written. */
export function checkBlocks(ctx: Ctx, text: string): void {
  const blocks = findBlocks(text)
  for (const block of blocks) if (block.problem) throw new WorkbusError(400, 'invalid_block', block.problem)
  const known = new Map<string, SchemaRecord | null>()
  for (const block of blocks) {
    if (!known.has(block.id)) known.set(block.id, findSchema(ctx, block.id))
    const schema = known.get(block.id)
    if (!schema) throw new WorkbusError(400, 'schema_not_found', 'the ' + block.id + " block names a schema this board doesn't have")
    const problem = checkValue(schema.schema, block.data)
    if (problem) throw new WorkbusError(400, 'invalid_block', 'the ' + block.id + " block doesn't match its schema: " + problem)
  }
}
hooks.checkBlocks = checkBlocks

op('schemas', (ctx) => {
  const own = ctx.sql.all<Row>('select * from schemas').map(viewOf).sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : a.version - b.version))
  return { schemas: [...BUILT_INS, ...own] }
}, { read: true })

op('schema', (ctx, { id }: { id: string }) => {
  if (!SCHEMA_ID.test(id)) throw badRequest(id + " doesn't name a schema: one is name@version, like sandbox@1", 'invalid_schema_id')
  const schema = findSchema(ctx, id)
  if (!schema) throw notFound('schema not found: ' + id, 'schema_not_found')
  return { schema }
}, { read: true })

/** Whether the caller has manage where * itself decides, after its x-board-can. */
function managesAll(ctx: Ctx): boolean {
  const access = grantAccess(ctx.board.grants(), ctx.caller)
  return access !== null && at(access.caller, '*').includes('manage')
}

op('createSchema', (ctx, body: { name: string; version: number; description?: string; schema: Schema }) => {
  if (!managesAll(ctx)) throw forbidden("this token can't register schemas: it needs manage at *")
  if (body.name.length > 80) throw badRequest('name: a schema name is up to 80 lowercase letters, numbers, and ._-, starting with a letter')
  if (body.version > 99999) throw badRequest('version: a schema version is at most 99,999')
  if (body.description !== undefined && body.description.length > 2000) throw badRequest('description: a schema description is at most 2,000 characters')
  if (RESERVED.has(body.name)) throw new WorkbusError(409, 'reserved_schema', body.name + ' is a built-in schema: register yours under another name')
  checkDefinition(body.schema)
  const id = body.name + '@' + body.version
  const description = body.description ?? null
  const there = ctx.sql.one<Row>('select * from schemas where id = ?', id)
  if (there) {
    if (canonical(JSON.parse(there.definition)) !== canonical(body.schema)) throw new WorkbusError(409, 'schema_immutable', id + ' is registered with another definition, and a version never changes: register a new version')
    if ((there.description ?? null) !== description) throw new WorkbusError(409, 'schema_immutable', id + ' is registered with another description, and a version never changes: register a new version')
    return { schema: viewOf(there), created: false }
  }
  if ((ctx.sql.one<{ n: number }>('select count(*) as n from schemas')?.n ?? 0) >= SCHEMAS_MAX) throw badRequest('a board registers at most 500 schema versions', 'too_many_schemas')
  const row: Row = { id, name: body.name, version: body.version, description, definition: JSON.stringify(body.schema), by: ctx.actor.id, at: ctx.now }
  ctx.sql.run('insert into schemas (id, name, version, description, definition, by, at) values (?, ?, ?, ?, ?, ?, ?)', row.id, row.name, row.version, row.description, row.definition, row.by, row.at)
  return { schema: viewOf(row), created: true }
})

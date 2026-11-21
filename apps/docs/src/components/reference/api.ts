// The HTTP API reference's data: src/data/openapi.json (scripts/refresh-openapi.mjs writes it from a
// running board) read as operations by domain, schemas as rows of fields, and examples as curl.
import doc from '../../data/openapi.json'

export type Schema = {
  type?: string | string[]
  properties?: Record<string, Schema>
  required?: string[]
  items?: Schema
  additionalProperties?: Schema | boolean
  propertyNames?: Schema
  anyOf?: Schema[]
  oneOf?: Schema[]
  enum?: unknown[]
  const?: unknown
  default?: unknown
  minLength?: number
  maxLength?: number
  minimum?: number
  maximum?: number
  exclusiveMinimum?: number
  minItems?: number
  maxItems?: number
  pattern?: string
  format?: string
  description?: string
}

export type Exchange = {
  request: { method: string; path: string; headers?: Record<string, string>; body?: unknown; bytes?: string; open?: boolean }
  status: number
  headers?: Record<string, string>
  response?: unknown
}

export type Parameter = { name: string; in: 'path' | 'query'; required: boolean; schema: Schema }

export type Operation = {
  method: string
  path: string
  operationId: string
  tags: string[]
  summary: string
  security: unknown[]
  'x-order': number
  'x-gateway'?: boolean
  'x-rules'?: string[]
  parameters?: Parameter[]
  requestBody?: { required: boolean; content: Record<string, { schema: Schema }>; 'x-headers'?: Record<string, string> }
  responses: Record<string, { description: string }>
  'x-example'?: Exchange
  'x-error-example'?: Exchange
}

export type Tag = { name: string; 'x-displayName': string; description: string }

export const openapi = doc as unknown as {
  info: { version: string }
  tags: Tag[]
  paths: Record<string, Record<string, Omit<Operation, 'method' | 'path'>>>
  'x-mcp': { tools: Tool[]; examples: Record<string, { request: unknown; response: unknown }> }
  'x-captured': { missingFromServedDocument: string[] }
}

export type Tool = { name: string; description: string; inputSchema: Schema; annotations?: { readOnlyHint?: boolean } }

export const operations: Operation[] = Object.entries(openapi.paths)
  .flatMap(([path, methods]) => Object.entries(methods).map(([method, operation]) => ({ ...operation, method: method.toUpperCase(), path }) as Operation))
  .sort((a, b) => a['x-order'] - b['x-order'])

export const tags: Tag[] = openapi.tags

export const byTag = (tag: string) => operations.filter((operation) => operation.tags.includes(tag))

/** The anchor an operation is linked by: post-tasks-id-claim. */
export const anchorOf = (operation: { method: string; path: string }) =>
  (operation.method + ' ' + operation.path).toLowerCase().replace(/[{}]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '')

// -- schemas as rows ---------------------------------------------------------------------------------

export type Row = { name: string; type: string; required: boolean; notes: string[]; pattern?: string }

const isObject = (schema: Schema) => schema.type === 'object' || schema.properties !== undefined

export function typeOf(schema: Schema | undefined): string {
  if (!schema || Object.keys(schema).length === 0) return 'any'
  const union = schema.anyOf ?? schema.oneOf
  if (union) return [...new Set(union.map(typeOf))].join(' | ')
  if (schema.enum) return schema.enum.map((value) => JSON.stringify(value)).join(' | ')
  if (schema.const !== undefined) return JSON.stringify(schema.const)
  if (Array.isArray(schema.type)) return schema.type.join(' | ')
  if (schema.type === 'array') {
    const item = typeOf(schema.items)
    return (item.includes('|') ? '(' + item + ')' : item) + '[]'
  }
  if (isObject(schema)) {
    if (schema.properties) return 'object'
    if (schema.additionalProperties && typeof schema.additionalProperties === 'object') return 'Record<string, ' + typeOf(schema.additionalProperties) + '>'
    return 'object'
  }
  return schema.type ?? 'any'
}

const num = (n: number) => n.toLocaleString('en-US')
const plural = (n: number, one: string) => num(n) + ' ' + one + (n === 1 ? '' : 's')

export function notesOf(schema: Schema): string[] {
  const notes: string[] = []
  const union = schema.anyOf ?? schema.oneOf
  if (union) {
    for (const member of union) if (member.type !== 'object' && member.type !== 'null') notes.push(...notesOf(member))
    return [...new Set(notes)]
  }
  const { minLength: min, maxLength: max } = schema
  if (min !== undefined && max !== undefined) notes.push(num(min) + ' to ' + plural(max, 'character'))
  else if (max !== undefined) notes.push('at most ' + plural(max, 'character'))
  else if (min !== undefined && min > 0) notes.push('at least ' + plural(min, 'character'))
  const low = schema.minimum ?? (schema.exclusiveMinimum !== undefined ? schema.exclusiveMinimum + 1 : undefined)
  if (low !== undefined && schema.maximum !== undefined) notes.push(num(low) + ' to ' + num(schema.maximum))
  else if (schema.maximum !== undefined) notes.push('at most ' + num(schema.maximum))
  else if (low !== undefined) notes.push('at least ' + num(low))
  if (schema.minItems !== undefined && schema.maxItems !== undefined) notes.push(num(schema.minItems) + ' to ' + plural(schema.maxItems, 'item'))
  else if (schema.maxItems !== undefined) notes.push('at most ' + plural(schema.maxItems, 'item'))
  else if (schema.minItems !== undefined) notes.push('at least ' + plural(schema.minItems, 'item'))
  if (schema.format === 'date-time') notes.push('an ISO 8601 time with its offset')
  if (schema.format === 'uri') notes.push('a URL')
  if (schema.default !== undefined) notes.push('default ' + JSON.stringify(schema.default))
  if (schema.type === 'array' && schema.items) for (const note of notesOf(schema.items)) notes.push('each ' + note)
  if (schema.propertyNames?.maxLength !== undefined) notes.push('keys at most ' + plural(schema.propertyNames.maxLength, 'character'))
  if (schema.additionalProperties && typeof schema.additionalProperties === 'object' && schema.additionalProperties.maxLength !== undefined)
    notes.push('values at most ' + plural(schema.additionalProperties.maxLength, 'character'))
  if (schema.description) notes.push(schema.description)
  return notes
}

const patternOf = (schema: Schema): string | undefined => schema.pattern ?? (schema.anyOf ?? []).map((member) => member.pattern).find(Boolean) ?? schema.items?.pattern

/** A schema's fields, nested ones under dotted names (tasks[].key, labels.<key>). */
export function rowsOf(schema: Schema | undefined, prefix = '', depth = 0): Row[] {
  if (!schema || depth > 4) return []
  const rows: Row[] = []
  const required = new Set(schema.required ?? [])
  for (const [key, field] of Object.entries(schema.properties ?? {})) {
    const name = prefix + key
    const pattern = patternOf(field)
    rows.push({ name, type: typeOf(field), required: required.has(key), notes: notesOf(field), ...(pattern ? { pattern } : {}) })
    const own = [field, ...(field.anyOf ?? [])].filter((member) => Boolean(member.properties))
    const items = [field.items, ...(field.items?.anyOf ?? [])].filter((member): member is Schema => Boolean(member?.properties))
    for (const member of own) rows.push(...rowsOf(member, name + '.', depth + 1))
    for (const member of items) rows.push(...rowsOf(member, name + '[].', depth + 1))
  }
  return rows
}

/** A union of object shapes (sync imports, receipts, grant principals): one table per shape. */
export function variantsOf(schema: Schema | undefined): { label: string; rows: Row[] }[] | null {
  const union = schema?.anyOf ?? schema?.oneOf
  if (!union || !union.every((member) => member.properties)) return null
  return union.map((member) => {
    const tag = Object.entries(member.properties!).find(([, field]) => field.const !== undefined)
    return { label: tag ? tag[0] + ': ' + JSON.stringify(tag[1].const) : 'one of', rows: rowsOf(member) }
  })
}

// -- examples as curl -----------------------------------------------------------------------------------

const quote = (text: string) => "'" + text.replace(/'/g, "'\\''") + "'"

/** The example's request as a curl command, against $BOARDS_URL with $BOARDS_TOKEN. */
export function curlOf(exchange: Exchange): string {
  const { request } = exchange
  const sends = request.body !== undefined || request.bytes !== undefined
  const method = request.method === 'GET' || (request.method === 'POST' && sends) ? '' : ' -X ' + request.method
  const lines = ['curl' + method + ' "$BOARDS_URL' + request.path + '"']
  if (!request.open) lines.push('-H "authorization: Bearer $BOARDS_TOKEN"')
  for (const [key, value] of Object.entries(request.headers ?? {})) lines.push('-H ' + quote(key + ': ' + value))
  let heredoc: string | null = null
  if (request.bytes !== undefined) {
    if (request.path.startsWith('/attachments')) lines.push('--data-binary @build.log')
    else {
      lines.push("--data-binary @- <<'EOF'")
      heredoc = request.bytes + '\nEOF'
    }
  } else if (request.body !== undefined) {
    const compact = JSON.stringify(request.body)
    lines.push('-d ' + quote(compact.length <= 72 ? compact : JSON.stringify(request.body, null, 2)))
  }
  const command = lines.join(' \\\n  ')
  const before = request.bytes !== undefined && request.path.startsWith('/attachments') ? 'printf ' + quote(request.bytes.replace(/\n/g, '\\n')) + ' > build.log\n' : ''
  return before + command + (heredoc ? '\n' + heredoc : '')
}

/** The example's answer as text: JSON pretty, anything else as it came. */
export function bodyOf(exchange: Exchange): { text: string; lang: string } | null {
  if (exchange.response === undefined) return null
  if (typeof exchange.response === 'string') return { text: exchange.response.replace(/\n$/, ''), lang: 'text' }
  return { text: JSON.stringify(exchange.response, null, 2), lang: 'json' }
}

export const STATUS: Record<number, string> = { 200: 'OK', 201: 'Created', 202: 'Accepted', 400: 'Bad Request', 401: 'Unauthorized', 403: 'Forbidden', 404: 'Not Found', 405: 'Method Not Allowed', 409: 'Conflict', 413: 'Content Too Large', 426: 'Upgrade Required', 501: 'Not Implemented', 503: 'Service Unavailable' }

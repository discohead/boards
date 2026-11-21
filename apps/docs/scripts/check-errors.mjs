#!/usr/bin/env node
// Lists every error code packages/workbus/src can answer with, and checks the Errors page names each.
//   node scripts/check-errors.mjs          codes the page is missing (exit 1 when any)
//   node scripts/check-errors.mjs --list   every code, its statuses, and where it's raised
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { dirname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const SRC = join(here, '..', '..', '..', 'packages', 'workbus', 'src')
const PAGE = join(here, '..', 'src', 'content', 'docs', 'reference', 'errors.mdx')

const files = []
const walk = (dir) => {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name)
    if (statSync(path).isDirectory()) walk(path)
    else if (path.endsWith('.ts')) files.push(path)
  }
}
walk(SRC)

/** The arguments of the call whose ( is at open, split at top-level commas. */
function argsAt(text, open) {
  const args = []
  let depth = 0, start = open + 1, quote = null
  for (let i = open; i < text.length; i++) {
    const c = text[i]
    if (quote) {
      if (c === '\\') i++
      else if (c === quote) quote = null
      continue
    }
    if (c === "'" || c === '"' || c === '\u0060') quote = c
    else if (c === '(' || c === '[' || c === '{') depth++
    else if (c === ')' || c === ']' || c === '}') {
      depth--
      if (depth === 0) {
        args.push(text.slice(start, i).trim())
        return args
      }
    } else if (c === ',' && depth === 1) {
      args.push(text.slice(start, i).trim())
      start = i + 1
    }
  }
  return args
}
const literal = (arg) => (/^'([a-z_]+)'$/.exec(arg ?? '') ?? [])[1]
const message = (arg) => (arg ?? '').replace(/\s+/g, ' ').slice(0, 160)

// helper(message, code?) and their default codes and statuses, as src/errors.ts defines them.
const HELPERS = {
  badRequest: { status: 400, code: 1, message: 0, fallback: 'invalid_request' },
  unauthorized: { status: 401, code: 1, message: 0, fallback: 'unauthorized' },
  forbidden: { status: 403, code: 1, message: 0, fallback: 'forbidden' },
  notFound: { status: 404, code: 1, message: 0, fallback: 'not_found' },
  conflict: { status: 409, code: 0, message: 1 },
  notKept: { status: 501, code: 0, message: 1 },
}

const found = new Map()
const add = (code, status, file, text, at, said) => {
  if (!code) return
  const line = text.slice(0, at).split('\n').length
  const entry = found.get(code) ?? { code, statuses: new Set(), places: [] }
  entry.statuses.add(status)
  entry.places.push({ where: relative(SRC, file) + ':' + line, said })
  found.set(code, entry)
}

for (const file of files) {
  const text = readFileSync(file, 'utf8')
  for (const match of text.matchAll(/new WorkbusError\(|\brefuse\(|\bcrossing\(\{|\b(badRequest|unauthorized|forbidden|notFound|conflict|notKept)\(/g)) {
    const open = match.index + match[0].length - (match[0].endsWith('{') ? 2 : 1)
    const args = argsAt(text, open)
    if (match[0].startsWith('new WorkbusError') || match[0].startsWith('refuse')) {
      const status = Number(args[0])
      if (Number.isFinite(status)) add(literal(args[1]), status, file, text, match.index, message(args[2]))
      continue
    }
    if (match[0].startsWith('crossing')) continue
    const helper = HELPERS[match[1]]
    if (text.slice(Math.max(0, match.index - 20), match.index).match(/(const|function|export const) $/)) continue
    add(literal(args[helper.code]) ?? helper.fallback ?? null, helper.status, file, text, match.index, message(args[helper.message]))
  }
  // Failures written as data: { status: 404, code: 'not_found', message: ... }
  for (const match of text.matchAll(/status: (\d{3}), code: '([a-z_]+)'(?:, message: ([^}]+))?/g)) add(match[2], Number(match[1]), file, text, match.index, message(match[3]))
}

const codes = [...found.values()].sort((a, b) => Math.min(...a.statuses) - Math.min(...b.statuses) || a.code.localeCompare(b.code))
if (process.argv.includes('--list')) {
  for (const entry of codes) {
    console.log([...entry.statuses].sort().join(',') + '  ' + entry.code + '  (' + entry.places.length + ')')
    for (const place of entry.places.slice(0, 3)) console.log('    ' + place.where + '  ' + place.said)
  }
  process.exit(0)
}
const page = readFileSync(PAGE, 'utf8')
const missing = codes.filter((entry) => !page.includes('\u0060' + entry.code + '\u0060'))
for (const entry of missing) console.log('missing  ' + [...entry.statuses].join(',') + '  ' + entry.code + '  ' + entry.places[0].where)
console.log(codes.length + ' codes, ' + missing.length + ' missing from the Errors page')
process.exitCode = missing.length ? 1 : 0

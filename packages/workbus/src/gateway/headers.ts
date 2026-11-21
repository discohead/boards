// The headers a request can carry: x-board-profile (an RFC 8941 Item: a name, an avatar parameter)
// and x-board-can (pattern=permissions;…, which only narrows).
import { WorkbusError } from '../errors.ts'
import { parseCan, type Grant } from '../ledger/access.ts'
import type { Profile } from '../ledger/core.ts'

const invalid = (why: string) => new WorkbusError(400, 'invalid_profile', 'x-board-profile is a structured header, like fixer;avatar="https://example.com/fixer.png": ' + why)
const PROFILE_NAME = /^[A-Za-z][A-Za-z0-9-]{0,31}$/
const TOKEN_CHAR = /[!#$%&'*+\-.^_\u0060|~0-9A-Za-z:/]/
const OTHER = /^(?:-?\d{1,15}|-?\d{1,12}\.\d{1,3}|\?[01]|:[A-Za-z0-9+/=]*:)$/

function bareItem(input: string, at: number): { value: string; kind: 'string' | 'token' | 'other'; next: number } {
  if (input[at] === '"') {
    let value = ''
    for (let i = at + 1; i < input.length; i++) {
      const char = input[i]!
      if (char === '\\') {
        const escaped = input[i + 1]
        if (escaped !== '"' && escaped !== '\\') throw invalid('a string escapes only " and \\')
        value += escaped
        i++
      } else if (char === '"') return { value, kind: 'string', next: i + 1 }
      else if (char < ' ' || char > '~') throw invalid('a string is printable ASCII')
      else value += char
    }
    throw invalid('a string is missing its closing "')
  }
  if (/[A-Za-z*]/.test(input[at] ?? '')) {
    let i = at
    while (i < input.length && TOKEN_CHAR.test(input[i]!)) i++
    return { value: input.slice(at, i), kind: 'token', next: i }
  }
  let i = at
  while (i < input.length && input[i] !== ';' && input[i] !== ' ') i++
  const value = input.slice(at, i)
  if (value === '') throw invalid('a parameter has no value after its =')
  if (!OTHER.test(value)) throw invalid(value + " isn't a value")
  return { value, kind: 'other', next: i }
}

export function parseProfile(header: string | null): Profile | null {
  if (header === null || header.trim() === '') return null
  let i = 0
  while (header[i] === ' ') i++
  const name = bareItem(header, i)
  if (name.kind === 'other') throw invalid(name.value === '' ? 'it names no profile' : name.value + " isn't a profile's name")
  i = name.next
  let avatar: string | null = null
  while (header[i] === ';') {
    i++
    while (header[i] === ' ') i++
    if (!/[a-z*]/.test(header[i] ?? '')) throw invalid('a parameter starts with a lowercase letter')
    let j = i
    while (j < header.length && /[a-z0-9_\-.*]/.test(header[j]!)) j++
    const key = header.slice(i, j)
    i = j
    if (header[i] === '=') {
      const value = bareItem(header, i + 1)
      if (key === 'avatar') {
        if (value.kind !== 'string') throw invalid('avatar is a string, in quotes')
        avatar = value.value
      }
      i = value.next
    }
  }
  while (header[i] === ' ') i++
  if (i < header.length) throw invalid('"' + header.slice(i, i + 20) + '" follows the profile')
  if (!PROFILE_NAME.test(name.value)) throw new WorkbusError(400, 'invalid_profile', 'profile names start with a letter and use up to 32 letters, numbers, and hyphens')
  if (avatar !== null) {
    let ok = false
    try {
      const url = new URL(avatar)
      ok = url.protocol === 'https:' || (url.protocol === 'http:' && (url.hostname === 'localhost' || url.hostname === '127.0.0.1'))
    } catch {}
    if (!ok) throw new WorkbusError(400, 'invalid_profile', 'avatars must be https URLs (http only on localhost)')
  }
  return { name: name.value, avatar }
}

export function parseNarrow(header: string | null): Record<string, Grant> | null {
  if (header === null) return null
  try {
    return parseCan(header)
  } catch (error) {
    if (error instanceof WorkbusError) throw new WorkbusError(400, 'invalid_scope', error.message)
    throw error
  }
}

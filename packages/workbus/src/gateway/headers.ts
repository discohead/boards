// The headers a request can carry: x-board-profile (an RFC 8941 Item: a name, an avatar parameter)
// and x-board-can (pattern=permissions;…, which only narrows).
import { WorkbusError } from '../errors.ts'
import { parseCan, type Grant } from '../ledger/access.ts'
import { RESERVED_HANDLES, type Profile } from '../ledger/core.ts'

const invalid = (why: string) => new WorkbusError(400, 'invalid_profile', 'x-board-profile is a structured header, like op;name="Operator";handle="op";avatar="https://example.com/op.png": ' + why)
const PROFILE_KEY = /^[A-Za-z][A-Za-z0-9-]{0,31}$/
const HANDLE = /^[a-z](?:[a-z0-9-]{0,30}[a-z0-9])?$/
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
  let named: string | null = null
  let handle: string | null = null
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
      if (key === 'avatar' || key === 'name' || key === 'handle') {
        if (value.kind !== 'string') throw invalid(key + ' is a string, in quotes')
        if (key === 'avatar') avatar = value.value
        else if (key === 'name') named = value.value
        else handle = value.value
      }
      i = value.next
    }
  }
  while (header[i] === ' ') i++
  if (i < header.length) throw invalid('"' + header.slice(i, i + 20) + '" follows the profile')
  return profileOf({ key: name.value, name: named ?? undefined, handle: handle ?? undefined, avatar })
}

/**
 * A profile as a caller gives it: its key (a letter, then up to 31 letters, numbers, and hyphens;
 * the actor is <principal>+<key, lowercased>), its display name (the key as written, when it gives
 * none), the handle it claims, and its avatar.
 */
export function profileOf(given: { key: string; name?: string; handle?: string | null; avatar?: string | null }): Profile {
  const refuse = (why: string) => new WorkbusError(400, 'invalid_profile', why)
  if (!PROFILE_KEY.test(given.key)) throw refuse("a profile's key starts with a letter and uses up to 32 letters, numbers, and hyphens")
  const name = (given.name ?? given.key).trim()
  if (name.length < 1 || [...name].length > 64) throw refuse("a profile's name is 1 to 64 characters")
  if (/\p{Cc}/u.test(name)) throw refuse("a profile's name has no control characters")
  let handle: string | null = null
  if (given.handle !== undefined && given.handle !== null) {
    handle = given.handle.replace(/^@/, '').toLowerCase()
    if (!HANDLE.test(handle)) throw refuse('a handle is 1 to 32 lowercase letters, numbers, and hyphens, starting with a letter: @op, @ops')
    if (RESERVED_HANDLES.includes(handle)) throw refuse('@' + handle + ' is reserved: filters read it as the caller')
  }
  const avatar = given.avatar ?? null
  if (avatar !== null) {
    let ok = false
    try {
      const url = new URL(avatar)
      ok = url.protocol === 'https:' || (url.protocol === 'http:' && (url.hostname === 'localhost' || url.hostname === '127.0.0.1'))
    } catch {}
    if (!ok) throw refuse('avatars must be https URLs (http only on localhost)')
  }
  return { key: given.key.toLowerCase(), name, ...(handle ? { handle } : {}), avatar, ...(given.name === undefined ? { named: false } : {}) }
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

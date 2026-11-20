// Who may do what, where. Permissions, channel patterns, and grants, decided in the Ledger in the
// transaction that writes, so a revocation is never outrun.
import { BoardsError } from '../errors.ts'

export const PERMISSIONS = ['read', 'post', 'react', 'label', 'sync', 'manage'] as const
export type Permission = (typeof PERMISSIONS)[number]

/** One hop of implication. Every verb that addresses a message implies read; post implies nothing (write-only). */
const IMPLIES: Record<Permission, readonly Permission[]> = {
  read: [],
  post: [],
  react: ['read'],
  label: ['read'],
  sync: ['read'],
  manage: ['read', 'post', 'react', 'label', 'sync'],
}

export type Grant = 'all' | readonly Permission[]
export type Can = Grant | Readonly<Record<string, Grant>>
export type Summary = Record<string, Permission[]>

export const CAN_MAX = 4000
const CHANNEL = /^[a-z0-9][a-z0-9_-]*(\/[a-z0-9][a-z0-9_-]*)*$/

export const invalidCan = (message: string) => new BoardsError(400, 'invalid_can', message)

export type Pattern = { kind: 'all' } | { kind: 'exact'; path: string } | { kind: 'subtree'; path: string }

export function parsePattern(pattern: string): Pattern {
  if (pattern === '*') return { kind: 'all' }
  if (pattern.includes('*')) {
    const before = pattern.slice(0, pattern.indexOf('*')).replace(/\/+$/, '')
    throw invalidCan('pattern ' + pattern + ': ' + (before === '' ? 'write * for every channel' : 'write ' + before + '/ for ' + before + ' and its subtree'))
  }
  if (pattern.endsWith('/')) {
    const path = pattern.slice(0, -1)
    if (!CHANNEL.test(path)) throw invalidCan('pattern ' + pattern + " isn't a channel and its subtree: write *, a channel, or a channel and its subtree (feedback/)")
    return { kind: 'subtree', path }
  }
  if (!CHANNEL.test(pattern)) throw invalidCan('pattern ' + pattern + " isn't a channel: write *, a channel, or a channel and its subtree (feedback/)")
  return { kind: 'exact', path: pattern }
}

/** How specific a pattern is for a channel it covers, higher is more: null when it doesn't cover it. */
export function specificity(pattern: string, channel: string): number | null {
  const parsed = parsePattern(pattern)
  if (parsed.kind === 'all') return 0
  if (parsed.kind === 'exact') return parsed.path === channel ? Number.MAX_SAFE_INTEGER : null
  return channel === parsed.path || channel.startsWith(parsed.path + '/') ? 1 + parsed.path.length : null
}

/** A grant's permissions with what each implies, in order. */
export function expand(grant: Grant): Permission[] {
  const out = new Set<Permission>()
  const add = (permission: Permission) => {
    if (out.has(permission)) return
    out.add(permission)
    for (const implied of IMPLIES[permission]) add(implied)
  }
  for (const permission of grant === 'all' ? PERMISSIONS : grant) add(permission)
  return PERMISSIONS.filter((permission) => out.has(permission))
}

/** A can as a map from pattern to grant. */
export function canMap(can: Can): Record<string, Grant> {
  if (can === 'all') return { '*': 'all' }
  if (Array.isArray(can)) return { '*': can as Permission[] }
  return { ...(can as Record<string, Grant>) }
}

/** The x-boards-can header (pattern=permissions;…), as the protocol writes it. */
export function parseCan(header: string, name = 'x-board-can'): Record<string, Grant> {
  if (header.length > CAN_MAX) throw invalidCan(name + ' is longer than ' + CAN_MAX + ' characters')
  const out: Record<string, Grant> = {}
  const entries = header.split(';').map((entry) => entry.trim())
  if (entries.every((entry) => entry === '')) throw invalidCan(name + ' is empty: write pattern=permissions, like dev/=read,post')
  for (const entry of entries) {
    if (entry === '') continue
    const split = entry.indexOf('=')
    if (split < 0) throw invalidCan(name + ' entry ' + entry + ' needs =: write pattern=permissions, like dev/=read,post')
    const pattern = entry.slice(0, split).trim()
    const list = entry.slice(split + 1).trim()
    if (Object.hasOwn(out, pattern)) throw invalidCan(name + ' lists ' + pattern + ' twice')
    parsePattern(pattern)
    const permissions = list === '' ? [] : list.split(',').map((permission) => permission.trim())
    if (permissions.length === 1 && permissions[0] === 'all') {
      out[pattern] = 'all'
      continue
    }
    for (const permission of permissions)
      if (!(PERMISSIONS as readonly string[]).includes(permission)) throw invalidCan(name + ': unknown permission ' + (permission || '(empty)') + ': use ' + PERMISSIONS.join(', ') + ', or all')
    out[pattern] = permissions as Permission[]
  }
  return out
}

export function canText(can: Record<string, Grant>): string {
  return Object.entries(can).map(([pattern, grant]) => pattern + '=' + (grant === 'all' ? 'all' : grant.join(','))).join(';')
}

/** What one map of patterns gives in a channel: its most specific pattern's grant, or null where none covers it. */
export function decide(map: Readonly<Record<string, Grant>>, channel: string): Permission[] | null {
  let best: { at: number; grant: Grant } | null = null
  for (const [pattern, grant] of Object.entries(map)) {
    const at = specificity(pattern, channel)
    if (at !== null && (!best || at > best.at)) best = { at, grant }
  }
  return best ? expand(best.grant) : null
}

/**
 * What a caller may do: a function of the channel. full means everything everywhere (the board's own
 * code, its owners' own Workers). Otherwise each channel is decided by the grants, then held to the
 * caller's narrowing (x-boards-can, .narrow()), which only narrows.
 */
export type Access = {
  can(permission: Permission, channel: string): boolean
  permissions(channel: string): Permission[]
  readable(channel: string): boolean
  /** Some channel where this holds: for routes that need a permission somewhere. */
  anywhere(permission: Permission): boolean
  /** Every channel: what a feed of the whole board needs. */
  everywhere(permission: Permission): boolean
  summary(): Summary
  narrowed: boolean
}

export function accessOf(options: { full: boolean; grants: Record<string, Grant>[]; levels?: undefined; narrow: Record<string, Grant> | null; resolve?: (channel: string) => Permission[] }): Access {
  const base = (channel: string): Permission[] => (options.full ? [...PERMISSIONS] : options.resolve ? options.resolve(channel) : [])
  const permissions = (channel: string): Permission[] => {
    const given = base(channel)
    if (!options.narrow) return given
    const held = decide(options.narrow, channel) ?? []
    return given.filter((permission) => held.includes(permission))
  }
  const patterns = () => {
    const out = new Set<string>(['*'])
    for (const map of options.grants) for (const pattern of Object.keys(map)) out.add(pattern)
    if (options.narrow) for (const pattern of Object.keys(options.narrow)) out.add(pattern)
    return [...out]
  }
  // A probe channel for a pattern: itself, or a child of a subtree.
  const probe = (pattern: string) => (pattern === '*' ? '\u0000any' : pattern.endsWith('/') ? pattern + '\u0000child' : pattern)
  return {
    narrowed: options.narrow !== null,
    permissions,
    can: (permission, channel) => permissions(channel).includes(permission),
    readable: (channel) => permissions(channel).includes('read'),
    anywhere: (permission) => patterns().some((pattern) => permissions(probe(pattern)).includes(permission)),
    everywhere: (permission) => patterns().every((pattern) => permissions(probe(pattern)).includes(permission)) && permissions('\u0000any').includes(permission),
    summary: () => Object.fromEntries(patterns().map((pattern) => [pattern, permissions(probe(pattern))])),
  }
}

export const PERMISSION_PHRASE: Record<Permission, (channel: string) => string> = {
  read: (channel) => 'read ' + channel,
  post: (channel) => 'post in ' + channel,
  react: (channel) => 'react in ' + channel,
  label: (channel) => 'label in ' + channel,
  sync: (channel) => 'sync in ' + channel,
  manage: (channel) => 'manage ' + channel,
}

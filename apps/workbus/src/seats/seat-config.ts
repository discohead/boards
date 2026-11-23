// A seat doc's config as a form edits it (design/workbus.md §4.4): its json#seat@1 or @2 block to the
// form's values and back. What the form doesn't show (role, avatar, automatic, the occupant's
// harness) is kept as the block had it. The charter prose is the doc editor's, never touched here.
import type { SchemaError } from '@/org/schema-check'

export const PERMISSIONS = ['read', 'post', 'react', 'label', 'edit', 'sync', 'manage'] as const
export type Permission = (typeof PERMISSIONS)[number]
/** The tools a seat doc may name today (org/rules.ts TOOLS). */
export const KNOWN_TOOLS = ['board', 'computer']
/** 'owned' (the state changes of tasks the seat made, #20) is seat@2's: a block that uses it is written as a seat@2. */
export const SIMPLE_WAKES = ['mention', 'follow', 'assigned', 'owned', 'dm', 'schedules'] as const
export const WAKE_KINDS = [...SIMPLE_WAKES, 'ready', 'docs', 'tail', 'dm-all'] as const
export type WakeKind = (typeof WAKE_KINDS)[number]
/** What a wake kind takes: a channel (ready, docs), a filter (tail), or nothing. */
export const WAKE_VALUE: Partial<Record<WakeKind, string>> = { ready: 'a queue channel, like eng/queue', docs: 'a docs path, like docs/specs/', tail: 'a feed filter' }

export type Block = Record<string, any>
export type SeatValues = {
  name: string
  handle: string
  model: string
  tools: string[]
  can: { pattern: string; all: boolean; permissions: Permission[] }[]
  wakes: { kind: WakeKind; value: string }[]
  sessions: string
  budgetMonth: string
  budgetAlert: string
  state: 'active' | 'paused'
  approve: { tool: string; kind: string }[]
}

export const FENCE = /(```json#seat@)([12])([^\n]*\n)([\s\S]*?)(\n```)/

/** The seat block in a doc's body, and the schema version it's written at; null when it has none (or it isn't JSON). */
export function blockIn(body: string): { block: Block; version: 1 | 2 } | null {
  const found = FENCE.exec(body)
  if (!found) return null
  try {
    return { block: JSON.parse(found[4]!) as Block, version: found[2] === '2' ? 2 : 1 }
  } catch {
    return null
  }
}

/** The version a block is written at: the doc's own, unless the change needs seat@2 (an 'owned' wake). */
export const versionFor = (block: Block, had: 1 | 2): 1 | 2 => (had === 2 || (Array.isArray(block.wakes) && block.wakes.includes('owned')) ? 2 : 1)

/** The body with its seat block replaced at a version, the rest (the charter) as it was. */
export const withBlock = (body: string, block: Block, version: 1 | 2) =>
  body.replace(FENCE, (_all, open: string, _v: string, rest: string, _old: string, close: string) => open + version + rest + JSON.stringify(block, null, 2) + close)

const text = (value: unknown) => (value === undefined || value === null ? '' : String(value))

export function valuesOf(block: Block): SeatValues {
  const wakes = (Array.isArray(block.wakes) ? block.wakes : []).map((rule: any): SeatValues['wakes'][number] => {
    if (typeof rule === 'string') return { kind: rule as WakeKind, value: '' }
    if (rule && typeof rule === 'object') {
      if ('ready' in rule) return { kind: 'ready', value: text(rule.ready) }
      if ('docs' in rule) return { kind: 'docs', value: text(rule.docs) }
      if ('tail' in rule) return { kind: 'tail', value: text(rule.tail) }
      if ('dm' in rule) return { kind: 'dm-all', value: '' }
    }
    return { kind: 'mention', value: '' }
  })
  return {
    name: text(block.name),
    handle: text(block.handle),
    model: text(block.occupant?.model),
    tools: Array.isArray(block.tools) ? [...block.tools] : ['board'],
    can: Object.entries((block.can ?? {}) as Record<string, 'all' | Permission[]>).map(([pattern, grant]) => ({ pattern, all: grant === 'all', permissions: grant === 'all' ? [] : [...grant] })),
    wakes,
    sessions: text(block.sessions),
    budgetMonth: text(block.budget?.month),
    budgetAlert: text(block.budget?.alert),
    state: block.state === 'paused' ? 'paused' : 'active',
    approve: Object.entries((block.approve ?? {}) as Record<string, string>).map(([tool, kind]) => ({ tool, kind })),
  }
}

/** A number field: empty leaves it out; anything else is a number, or the text itself so the schema says what's wrong. */
const numberOf = (value: string): number | string | undefined => (value.trim() === '' ? undefined : Number.isFinite(Number(value)) ? Number(value) : value)

/** The form's values as a block, over what the block had. */
export function blockOf(values: SeatValues, had: Block): Block {
  const out: Block = {}
  if (had.role !== undefined) out.role = had.role
  if (values.name.trim()) out.name = values.name.trim()
  if (values.handle.trim()) out.handle = values.handle.trim().replace(/^@/, '')
  if (had.avatar !== undefined) out.avatar = had.avatar
  if (values.model.trim()) out.occupant = { harness: had.occupant?.harness ?? 'pi', model: values.model.trim() }
  out.tools = values.tools
  out.can = Object.fromEntries(values.can.map((row) => [row.pattern.trim(), row.all ? 'all' : PERMISSIONS.filter((one) => row.permissions.includes(one))]))
  out.wakes = values.wakes.map((row) => (row.kind === 'ready' ? { ready: row.value.trim() } : row.kind === 'docs' ? { docs: row.value.trim() } : row.kind === 'tail' ? { tail: row.value.trim() } : row.kind === 'dm-all' ? { dm: true } : row.kind))
  if (values.approve.length) out.approve = Object.fromEntries(values.approve.map((row) => [row.tool.trim(), row.kind.trim()]))
  if (had.automatic !== undefined) out.automatic = had.automatic
  const sessions = numberOf(values.sessions)
  if (sessions !== undefined) out.sessions = sessions
  const month = numberOf(values.budgetMonth)
  const alert = numberOf(values.budgetAlert)
  if (month !== undefined || alert !== undefined) out.budget = { ...(month !== undefined ? { month } : {}), ...(alert !== undefined ? { alert } : {}) }
  out.state = values.state
  return out
}

/** A schema error's path in the block, as the form's field it belongs to (null: the form's own). */
export function fieldOf(error: SchemaError, values: SeatValues): string | null {
  const path = error.path
  if (path === 'name' || path === 'handle' || path === 'state' || path === 'sessions') return path
  if (path.startsWith('occupant')) return 'model'
  if (path.startsWith('tools')) return 'tools'
  if (path === 'budget.month') return 'budgetMonth'
  if (path === 'budget.alert') return 'budgetAlert'
  const wake = /^wakes\[(\d+)\]/.exec(path)
  if (wake) return 'wakes[' + wake[1] + '].value'
  if (path.startsWith('can.')) {
    const at = values.can.findIndex((row) => row.pattern.trim() === path.slice(4).replace(/\[\d+\]$/, ''))
    return at >= 0 ? 'can[' + at + '].pattern' : 'can'
  }
  if (path.startsWith('approve.')) {
    const at = values.approve.findIndex((row) => row.tool.trim() === path.slice(8))
    return at >= 0 ? 'approve[' + at + '].kind' : 'approve'
  }
  return null
}

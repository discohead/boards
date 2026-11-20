// The event feed: the board log, read in order, as the caller may see it. A page is at most 200
// events, its cursor the last one examined, matched or not. Waits are the Gateway's to hold.
import { badRequest } from '../errors.ts'
import { cursorOf, iso, ref, type Facet } from './core.ts'
import { compile, matches, type Compiled, type Filters } from './messages.ts'
import { hooks, op, viewOptions, type Ctx } from './ops.ts'

export const HIDDEN = new Set(['actor.seen', 'message.synced', 'message.files_synced', 'task.renewed'])
const PAGE = 200
const LAST_PAGES = 10

type EventRow = { seq: number; type: string; thread: number | null; message: number | null; actor: string | null; at: number; payload: string; facets: string }

/** A payload as clients see it: refs for IDs, no secrets, links as the reader may see them. */
export function payloadView(ctx: Ctx, payload: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(payload)) {
    if (key === 'token' || key === 'mentions' || key === 'along') continue
    if ((key === 'id' || key === 're' || key === 'replyTo') && typeof value === 'number') out[key] = ref(value)
    else if (key === 'needs' && Array.isArray(value)) out[key] = value.map((item) => (typeof item === 'number' ? ref(item) : item))
    else if (key === 'schedule' && value && typeof value === 'object' && typeof (value as { id: unknown }).id === 'number') out[key] = { id: 's' + (value as { id: number }).id, n: (value as { n: number }).n }
    else if (key === 'links' && Array.isArray(value)) out[key] = value.map((link) => ctx.board.linkView(link, ctx.access))
    else if (key === 'by' && value && typeof value === 'object') {
      const by = value as { actor: string; principal: string; profile?: string | null }
      out[key] = { actor: by.actor, principal: by.principal, profile: by.profile ?? null }
    } else out[key] = value
  }
  return out
}

/** Whether the caller sees an event, and its view when it does. */
export function eventView(ctx: Ctx, row: EventRow, compiled: Compiled, all: boolean, readsAll: boolean): Record<string, unknown> | null {
  const facets = JSON.parse(row.facets) as { before: Facet | null; after: Facet | null } | null
  const concerned = facets ? (facets.after ?? facets.before) : null
  const readable = row.message === null ? readsAll : concerned !== null && ctx.access.readable(concerned.channel)
  if (!readable) return null
  if (HIDDEN.has(row.type) && !all) return null
  if (compiled.criteria) {
    if (row.message === null || !facets) return null
    if (!(matches(compiled, facets.before) || matches(compiled, facets.after))) return null
  } else if (row.message === null && !all) return null
  const payload = JSON.parse(row.payload) as Record<string, unknown>
  const view: Record<string, unknown> = { cursor: ref(row.seq), type: row.type, createdAt: iso(row.at), payload: payloadView(ctx, payload) }
  if (row.message !== null) {
    const message = ctx.board.message(row.message)
    if (message) view.message = ctx.board.view(message, { ...viewOptions(ctx), taskView: (root: number) => hooks.taskView(ctx, root, row.seq) })
  }
  const by = payload.by as { actor?: string } | undefined
  if (by?.actor) {
    const actor = ctx.board.actor(by.actor)
    if (actor) view.actor = { id: actor.id, ...ctx.board.actorView(actor)! }
  }
  return view
}

export type EventsQuery = Filters & { after?: string; all?: boolean; last?: number }

op('events', (ctx, query: EventsQuery) => {
  if (query.last !== undefined && query.after !== undefined) throw badRequest("last: \u0060last\u0060 reads the newest events at once: it takes no \u0060after\u0060 or \u0060wait\u0060")
  const compiled = compile(ctx, query)
  const readsAll = ctx.access.everywhere('read')
  const all = Boolean(query.all)
  const head = ctx.board.head
  if (query.last !== undefined) {
    const kept: Record<string, unknown>[] = []
    let to = head
    for (let pages = 0; pages < LAST_PAGES && to >= 1 && kept.length < query.last; pages++) {
      const from = Math.max(1, to - PAGE + 1)
      const rows = hooks.eventRows(ctx, from - 1, to - from + 1, to)
      const found = rows.map((row) => eventView(ctx, row, compiled, all, readsAll)).filter((view): view is Record<string, unknown> => view !== null)
      kept.unshift(...found)
      to = from - 1
    }
    return { events: kept.slice(-query.last), cursor: ref(head) }
  }
  const start = query.after === undefined ? head : Math.min(cursorOf(query.after), head)
  const rows = hooks.eventRows(ctx, start, PAGE)
  const events = rows.map((row) => eventView(ctx, row, compiled, all, readsAll)).filter((view): view is Record<string, unknown> => view !== null)
  return { events, cursor: ref(rows.at(-1)?.seq ?? start) }
}, { read: true })
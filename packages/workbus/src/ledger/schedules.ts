// Scheduled messages: a message posted later, once or repeating, as the one who scheduled it.
// A schedule is a side fact (the schedules table, never the board log); each send is a
// message.posted like any post, made by a 'send' timer that works out the creator's access again
// under the grants as they are then. Schedule IDs are 's<n>', n from a counter in meta.
import { badRequest, WorkbusError, forbidden, notFound } from '../errors.ts'
import { authorize, authorOf, iso, ref, type ActorRecord, type Author, type Caller, type MessageRow, type Principal, type Profile } from './core.ts'
import type { Grant } from './access.ts'
import { MESSAGE_TEXT_MAX, postMessage, refuseReserved, settle, textTooLong } from './messages.ts'
import { hooks, op, TIMERS, type Ctx } from './ops.ts'
import { json } from './sql.ts'

const MIN_EVERY_MS = 60_000
const MAX_AHEAD_MS = 366 * 86_400_000
const UNIT: Record<string, number> = { s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000 }
const duration = (value: string) => {
  const found = /^(\d+(?:\.\d+)?)(s|m|h|d)$/.exec(value)!
  return Math.round(Number(found[1]) * UNIT[found[2]!]!)
}

/** The board's own cancels (a thread deleted, access revoked) are by this author. */
const BOARD_SCHEDULE: Author = { actor: 'board:schedule', principal: 'board:schedule', profile: null }

type Spec = {
  text: string
  labels: Record<string, string>
  noSync: boolean
  attachments: { id: string; name: string; type: string; size: number }[]
  first: number
  every: number | null
  until: number | null
  times: number | null
  blind: boolean
}
/** Who made it: enough to act as them again at each send. Never a token. */
type Creator = { author: Author; principal: Principal; profile: Profile | null; narrow: Record<string, Grant> | null; actor: ActorRecord }
type Canceled = { by: Author; reason: 'canceled' | 'thread_deleted' | 'dropped' | 'revoked' }
type ScheduleRow = { id: number; spec: string; creator: string; channel: string; re: number | null; n: number; next: number | null; state: 'pending' | 'done' | 'canceled'; canceled: string | null; last: number | null; at: number }

type Schedule = { id: number; spec: Spec; creator: Creator; channel: string; re: number | null; n: number; next: number | null; state: ScheduleRow['state']; canceled: Canceled | null; last: number | null; at: number }

const parse = (row: ScheduleRow): Schedule => ({ ...row, spec: JSON.parse(row.spec), creator: JSON.parse(row.creator), canceled: json<Canceled | null>(row.canceled, null) })

function load(ctx: Pick<Ctx, 'sql'>, id: number): Schedule | null {
  const row = ctx.sql.one<ScheduleRow>('select * from schedules where id = ?', id)
  return row ? parse(row) : null
}

function nextId(ctx: Pick<Ctx, 'sql'>): number {
  ctx.sql.run("insert into meta (key, value) values ('schedules', '1') on conflict (key) do update set value = cast(cast(value as integer) + 1 as text)")
  return Number(ctx.sql.one<{ value: string }>("select value from meta where key = 'schedules'")!.value)
}

/** For a reader who can't read the channel: every exact mention but of themselves shows as @… */
const blindText = (text: string, self: string) => text.replace(/@\[([^\]\s]+)\]/g, (whole, actor: string) => (actor === self ? whole : '@\u2026'))

function view(ctx: Ctx, schedule: Schedule): Record<string, unknown> {
  const { spec, creator } = schedule
  const readable = ctx.access.readable(schedule.channel)
  const record = ctx.board.actor(creator.author.actor) ?? creator.actor
  return {
    id: 's' + schedule.id,
    channel: schedule.channel,
    re: schedule.re === null ? null : ref(schedule.re),
    text: readable ? spec.text : blindText(spec.text, ctx.actor.id),
    labels: spec.labels,
    noSync: spec.noSync,
    attachments: spec.attachments,
    first: iso(spec.first),
    every: spec.every,
    until: spec.until === null ? null : iso(spec.until),
    times: spec.times,
    sent: schedule.n,
    next: schedule.next === null ? null : iso(schedule.next),
    last: schedule.last === null ? null : ref(schedule.last),
    state: schedule.state,
    canceled: schedule.canceled,
    by: creator.author,
    author: { kind: record.kind, handle: record.handle, name: record.name, avatar: record.avatar, ...(record.via ? { via: record.via } : {}) },
    createdAt: iso(schedule.at),
  }
}

/** Whether the caller made this schedule, as the one it posts as, and may still post where it does. */
function createdBy(ctx: Ctx, schedule: Schedule): boolean {
  const { author } = schedule.creator
  const wroteAs = author.principal === ctx.author.principal && (ctx.actor.id === ctx.author.principal || ctx.actor.id === author.actor)
  return wroteAs && ctx.access.can('post', schedule.channel) && (schedule.spec.blind || ctx.access.readable(schedule.channel))
}
const visible = (ctx: Ctx, schedule: Schedule) => ctx.access.readable(schedule.channel) || createdBy(ctx, schedule)

function finish(ctx: Ctx, schedule: Schedule, canceled: Canceled) {
  ctx.sql.run("update schedules set state = 'canceled', canceled = ?, next = null where id = ?", JSON.stringify(canceled), schedule.id)
  ctx.clearTimer('send', String(schedule.id))
}

// -- making one ------------------------------------------------------------------------------

type ScheduleBody = { channel?: string; re?: string; text: string; labels?: Record<string, string>; noSync?: boolean; attachments?: string[]; in?: string; at?: string; every?: string; until?: string; for?: string; times?: number }

op('schedule', (ctx, body: ScheduleBody) => {
  const labels = body.labels ?? {}
  refuseReserved(Object.keys(labels))
  let text = body.text ?? ''
  if (text.includes('json#')) hooks.checkBlocks(ctx, text)
  // Mentions settle once, now, against the thread they'll reply in: a send is never settled again.
  const named = body.re !== undefined && /^[1-9]\d{0,15}$/.test(body.re) ? ctx.board.message(Number(body.re)) : null
  const settled = settle(ctx, text, named && ctx.access.readable(named.channel) ? (named.re ?? named.id) : null)
  text = settled.text
  if (text.length > MESSAGE_TEXT_MAX) throw textTooLong()
  const ids = [...new Set(body.attachments ?? [])]
  if (ids.length > 10) throw badRequest('attachments: a message carries at most 10')

  let channel: string
  let target: MessageRow | null = null
  if (body.re !== undefined) {
    target = ctx.board.readable(body.re, ctx.access)
    const root = target.re === null ? target : ctx.board.message(target.re)
    channel = root?.channel ?? target.channel
  } else channel = body.channel!
  authorize(ctx.access, 'post', channel)
  if (Object.keys(labels).length) authorize(ctx.access, 'label', channel)
  const attachments = ids.length ? (hooks.attachments(ctx, ids) as Spec['attachments']) : []

  const now = ctx.now
  const every = body.every !== undefined ? duration(body.every) : null
  const first = body.at !== undefined ? Date.parse(body.at) : now + duration(body.in ?? body.every!)
  const until = body.until !== undefined ? Date.parse(body.until) : body.for !== undefined ? first + duration(body.for) : null
  if (every !== null && every < MIN_EVERY_MS) throw badRequest('\u0060every\u0060 is at least 1m')
  if (every !== null && every > MAX_AHEAD_MS) throw badRequest('\u0060every\u0060 is at most a year')
  if (first < now - 60_000) throw badRequest('\u0060at\u0060 is in the past')
  if (until !== null && until < first) throw badRequest('the schedule stops before its first send')
  if (first > now + MAX_AHEAD_MS || (until !== null && until > now + MAX_AHEAD_MS)) throw badRequest('a schedule reaches at most a year out: its first send and its stop')

  let re: number | null = null
  if (target) {
    if (target.deleted) throw notFound('message not found: #' + target.id, 'message_not_found')
    const rootId = target.re ?? target.id
    const root = ctx.board.message(rootId)
    if (!root || root.deleted) throw notFound('message not found: #' + rootId, 'message_not_found')
    re = root.id
    channel = root.channel
  }

  const spec: Spec = { text, labels, noSync: Boolean(body.noSync), attachments, first, every, until, times: body.times ?? null, blind: !ctx.access.readable(channel) }
  const creator: Creator = { author: ctx.author, principal: ctx.caller.principal, profile: ctx.caller.profile, narrow: ctx.caller.narrow, actor: ctx.actor }
  const id = nextId(ctx)
  ctx.sql.run(
    "insert into schedules (id, spec, creator, channel, re, n, next, state, canceled, last, at) values (?, ?, ?, ?, ?, 0, ?, 'pending', null, null, ?)",
    id, JSON.stringify(spec), JSON.stringify(creator), channel, re, first, now,
  )
  ctx.timer('send', String(id), first)
  return { schedule: view(ctx, load(ctx, id)!), ...(settled.mentions ? { mentions: settled.mentions } : {}) }
})

// -- reading and canceling --------------------------------------------------------------------

type SchedulesQuery = { re?: string; channel?: string; by?: string; all?: boolean }

/** The schedules a caller sees: in a channel it reads, or its own; filtered as the query says, oldest first. */
function list(ctx: Ctx, query: SchedulesQuery & { root?: number }): Schedule[] {
  let root = query.root
  if (query.re !== undefined) {
    const named = ctx.board.readable(query.re, ctx.access)
    root = named.re ?? named.id
  }
  const rows = root !== undefined
    ? ctx.sql.all<ScheduleRow>('select * from schedules where re = ? order by id', root)
    : ctx.sql.all<ScheduleRow>('select * from schedules order by id')
  let actors: Set<string> | null = null
  if (query.by !== undefined) {
    if (query.by === 'me') actors = new Set([ctx.actor.id])
    else {
      const known = ctx.board.actor(query.by)
      actors = new Set(known ? [known.id] : ctx.sql.all<{ id: string }>('select id from actors where handle_lc = ?', query.by.toLowerCase()).map((row) => row.id))
    }
  }
  return rows.map(parse).filter((schedule) =>
    visible(ctx, schedule)
    && (query.all || schedule.next !== null)
    && (query.channel === undefined || schedule.channel === query.channel)
    && (actors === null || actors.has(schedule.creator.author.actor)))
}

op('schedules', (ctx, query: SchedulesQuery) => ({ schedules: list(ctx, query).map((schedule) => view(ctx, schedule)) }), { read: true })

op('cancelSchedule', (ctx, { id }: { id: string }) => {
  const parsed = /^s{0,2}([1-9]\d{0,15})$/.exec(id)
  const missing = () => notFound('schedule not found: s' + (parsed ? parsed[1] : id.replace(/^s{1,2}/, '')), 'schedule_not_found')
  const schedule = parsed ? load(ctx, Number(parsed[1])) : null
  if (!schedule) throw missing()
  if (!createdBy(ctx, schedule) && !ctx.access.can('manage', schedule.channel)) {
    if (!ctx.access.readable(schedule.channel)) throw missing()
    throw forbidden("this token can't manage " + schedule.channel)
  }
  if (schedule.state !== 'pending') return { schedule: view(ctx, schedule), canceled: false }
  finish(ctx, schedule, { by: ctx.author, reason: 'canceled' })
  return { schedule: view(ctx, load(ctx, schedule.id)!), canceled: true }
})

/** A thread's pending schedules, for its view. */
hooks.threadSchedules = (ctx, root) => list(ctx, { root }).map((schedule) => view(ctx, schedule))

// -- sending ----------------------------------------------------------------------------------

/** A send's client key: a UUIDv8 derived from the schedule and the send, so a retry finds what it posted. */
export function sendKey(id: number, n: number): string {
  const hex = '5c' + id.toString(16).padStart(13, '0') + n.toString(16).padStart(15, '0')
  return hex.slice(0, 8) + '-' + hex.slice(8, 12) + '-8' + hex.slice(12, 15) + '-8' + hex.slice(15, 18) + '-' + hex.slice(18, 30)
}

/** After send n, due at at, went out at now: the first slot after now, or null when it's done. */
function nextAfter(spec: Spec, n: number, at: number, now: number): number | null {
  if (spec.every === null) return null
  if (spec.times !== null && n + 1 >= spec.times) return null
  const next = at + spec.every * Math.max(1, Math.floor((now - at) / spec.every) + 1)
  if (spec.until !== null && next > spec.until) return null
  return next
}

const refused = (error: unknown) => {
  const status = (error as { status?: unknown })?.status
  return status === 403 || status === 404
}

TIMERS.send = (ctx, timerRef) => {
  const schedule = load(ctx, Number(timerRef))
  if (!schedule || schedule.state !== 'pending' || schedule.next === null) return
  const due = schedule.next
  // Early (more than a second): armed again for when it's due.
  if (due > ctx.now + 1000) return ctx.timer('send', String(schedule.id), due)
  const n = schedule.n
  if (schedule.re !== null) {
    const root = ctx.board.message(schedule.re)
    if (!root || root.deleted) return finish(ctx, schedule, { by: BOARD_SCHEDULE, reason: 'thread_deleted' })
  }
  // As the creator, with what the grants give them now (narrowed as they were).
  const { creator, spec } = schedule
  const caller: Caller = { principal: creator.principal, profile: creator.profile, narrow: creator.narrow, via: 'board' }
  const as: Ctx = { ...ctx, caller, author: authorOf(caller), actor: ctx.board.actorFor(caller), access: ctx.board.access(caller) }
  let posted: MessageRow
  try {
    const body = { text: spec.text, labels: spec.labels, noSync: spec.noSync, attachments: spec.attachments.map((file) => file.id), ...(schedule.re !== null ? { re: ref(schedule.re) } : { channel: schedule.channel }) }
    posted = postMessage(as, body, { schedule: { id: schedule.id, n }, settle: false, checkBlocks: false, clientKey: sendKey(schedule.id, n) }).row
  } catch (error) {
    if (refused(error)) return finish(ctx, schedule, { by: BOARD_SCHEDULE, reason: 'revoked' })
    throw error instanceof WorkbusError ? error : Object.assign(new Error('schedule send failed'), { cause: error })
  }
  const next = nextAfter(spec, n, due, ctx.now)
  ctx.sql.run('update schedules set n = ?, last = ?, next = ?, state = ? where id = ?', n + 1, posted.id, next, next === null ? 'done' : 'pending', schedule.id)
  if (next !== null) ctx.timer('send', String(schedule.id), next)
}

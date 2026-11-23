// Subscriptions (design/registered-watchers.md): registered watchers the board delivers. A caller
// subscribes as itself, whole (its principal, profile, and narrowing), to a service sink its
// deployment declares and lets it target, with rules a seat doc holds. After each write the Ledger
// matches each subscription's new events as that caller, with the grants as they are then, and
// hands the matches to its Mailbox (ledger.ts, dispatch), which delivers them in order per thread.
import { WorkbusError, badRequest, forbidden, notFound } from '../errors.ts'
import { canText, type Grant } from './access.ts'
import { authorOf, iso, type Caller, type Facet, type Principal, type Profile } from './core.ts'
import { eventView } from './feed.ts'
import { compile, matches as facetMatches, type Compiled } from './messages.ts'
import { DDL } from './schema.ts'
import { contextFor, hooks, op, type Ctx, type EventRow, type Mount } from './ops.ts'
import { parseWatcherTail, sha256 } from './watchers.ts'

DDL.push(
  'create table if not exists subscriptions (owner text not null, key text not null, principal text not null, profile text, narrow text, sink text not null, rules text not null, revision integer, hash text not null, created integer not null, at integer not null, primary key (owner, key)) strict, without rowid',
)

export const SUBSCRIPTIONS_MAX = 256
export const RULES_MAX = 16
const KEY = /^[a-z0-9][a-z0-9._/-]{0,63}$/
const RULE_ID = /^[A-Za-z][A-Za-z0-9-]{0,31}$/

/** A service sink a deployment declares (WorkbusConfig.sinks): the binding it calls, and who may target it. */
export type SinkConfig = { binding: string; method?: string; principals: readonly string[] }

export type Rule = 'mention' | 'follow' | 'assigned' | 'dm' | 'schedules' | { ready: string } | { docs: string } | { dm: true } | { tail: string }

export type Subscription = { owner: string; key: string; principal: Principal; profile: Profile | null; narrow: Record<string, Grant> | null; sink: string; rules: Record<string, Rule>; revision: number | null; hash: string; created: number; at: number }
type Row = { owner: string; key: string; principal: string; profile: string | null; narrow: string | null; sink: string; rules: string; revision: number | null; hash: string; created: number; at: number }

const parse = (row: Row): Subscription => ({
  owner: row.owner, key: row.key, principal: JSON.parse(row.principal), profile: row.profile ? JSON.parse(row.profile) : null, narrow: row.narrow ? JSON.parse(row.narrow) : null,
  sink: row.sink, rules: JSON.parse(row.rules), revision: row.revision, hash: row.hash, created: row.created, at: row.at,
})

export const subscriptionsOf = (ctx: Pick<Ctx, 'sql'>): Subscription[] => ctx.sql.all<Row>('select * from subscriptions order by owner, key').map(parse)
export const subscriptionOf = (ctx: Pick<Ctx, 'sql'>, owner: string, key: string): Subscription | null => {
  const row = ctx.sql.one<Row>('select * from subscriptions where owner = ? and key = ?', owner, key)
  return row ? parse(row) : null
}

/** Where a subscription's cursor is kept (the outbox: it also keeps its events hot), and its Mailbox's name after the board's. */
export const subscriptionId = (owner: string, key: string) => 'sub:' + owner + '/' + key

/** The caller a subscription matches as: who subscribed, as it was then. */
export const subscriberOf = (sub: Pick<Subscription, 'principal' | 'profile' | 'narrow'>): Caller => ({ principal: sub.principal, profile: sub.profile, narrow: sub.narrow, via: 'subscription' })

/** Whether a sink lets a principal target it. */
export const sinkAllows = (sink: SinkConfig | undefined, principal: string) => Boolean(sink && sink.principals.includes(principal))

const view = (sub: Subscription) => ({
  key: sub.key,
  sink: sub.sink,
  rules: sub.rules,
  revision: sub.revision,
  principal: sub.owner,
  actor: authorOf(subscriberOf(sub)).actor,
  can: sub.narrow ? canText(sub.narrow) : null,
  createdAt: iso(sub.created),
  updatedAt: iso(sub.at),
})

// -- rules ---------------------------------------------------------------------------------------

/** A channel, or a channel and its subtree (work/). */
const CHANNEL = /^[a-z0-9][a-z0-9_-]*(\/[a-z0-9][a-z0-9_-]*)*\/?$/
const within = (pattern: string, channel: string) => (pattern.endsWith('/') ? channel === pattern.slice(0, -1) || channel.startsWith(pattern) : channel === pattern)

type Matcher = (row: EventRow, facets: { before: Facet | null; after: Facet | null }, payload: Record<string, unknown>, by: string | null) => boolean

const TASK_RECEIPTS = new Set(['message.synced', 'message.files_synced', 'task.renewed'])
const DOCS = new Set(['doc.created', 'doc.edited', 'doc.moved'])
/** The events a rule may match: what registered watchers see, and docs' own. */
export const SUBSCRIBED = new Set(['message.posted', 'message.edited', 'message.deleted', 'reaction.added', 'reaction.removed', 'labels.changed', 'message.sync_failed', 'message.synced', 'message.files_synced', 'task.created', 'task.assigned', 'task.needs_changed', 'task.ready', 'task.claimed', 'task.renewed', 'task.released', 'task.expired', 'task.completed', 'task.failed', 'task.blocked', 'task.unblocked', 'task.canceled', 'task.reopened', ...DOCS])

function tailOf(ctx: Ctx, expression: string): { compiled: Compiled; all: boolean } {
  // 'me' is the subscriber: a registered watcher has no me, a subscription is one.
  const spec = parseWatcherTail(expression.replace(/(--(?:mentions|for|by)(?:=|\s+))me\b/g, '$1' + ctx.actor.id))
  return { compiled: compile(ctx, spec), all: Boolean(spec.all) }
}

/** A rule as a test of an event, for the subscriber ctx is. Throws an Error whose message is the reason a rule can't be. */
function matcherOf(ctx: Ctx, rule: Rule): Matcher {
  const self = ctx.actor.id
  const terms = new Set([self, ctx.actor.handle.toLowerCase()])
  const mentions = (facet: Facet | null) => Boolean(facet && facet.terms.some((value) => terms.has(value)))
  const concerned = (facets: { before: Facet | null; after: Facet | null }) => facets.after ?? facets.before
  const taskFor = (root: number, at: number) => (hooks.taskView(ctx, root, at) as { for?: string | null } | undefined)?.for ?? null
  if (rule === 'mention') return (row, facets) => (row.type === 'message.posted' && mentions(facets.after)) || (row.type === 'message.edited' && mentions(facets.after) && !mentions(facets.before))
  if (rule === 'follow') return (row, facets) => [facets.before, facets.after].some((facet) => Boolean(facet && ((facet.followers ?? []).includes(self) || mentions(facet))))
  if (rule === 'assigned')
    return (row, facets) => {
      const facet = concerned(facets)!
      const root = facet.re ?? facet.id
      // As the event left the task, or, for one that took it away, as it was just before.
      return taskFor(root, row.seq) === self || (row.type === 'task.assigned' && taskFor(root, row.seq - 1) === self)
    }
  if (rule === 'schedules') return (row, _facets, payload, by) => row.type === 'message.posted' && Boolean(payload.schedule) && by === self
  if (rule === 'dm' || (typeof rule === 'object' && 'dm' in rule)) {
    if (!ctx.caller.profile) throw new Error('a dm rule is for a profile: subscribe as one (x-board-profile, or .as())')
    const channel = 'dm/' + ctx.caller.profile.name.toLowerCase() + '/'
    return (_row, facets) => within(channel, concerned(facets)!.channel)
  }
  if (typeof rule === 'object' && 'ready' in rule) {
    const channel = rule.ready
    return (row, facets) => {
      const after = facets.after
      if (!row.type.startsWith('task.') || !after || after.re !== null || !within(channel, after.channel)) return false
      if (after.labels['board.task'] !== 'ready' || facets.before?.labels['board.task'] === 'ready') return false
      const assignee = taskFor(after.id, row.seq)
      return assignee === null || assignee === self
    }
  }
  if (typeof rule === 'object' && 'docs' in rule) {
    const channel = rule.docs
    return (row, facets) => DOCS.has(row.type) && [facets.before, facets.after].some((facet) => Boolean(facet && within(channel, facet.channel)))
  }
  if (typeof rule === 'object' && 'tail' in rule) {
    const { compiled, all } = tailOf(ctx, rule.tail)
    return (row, facets, _payload, by) => {
      if (DOCS.has(row.type)) return false
      if (TASK_RECEIPTS.has(row.type) && !all) return false
      if (!compiled.criteria) return true
      return facetMatches(compiled, facets.before, by) || facetMatches(compiled, facets.after, by)
    }
  }
  throw new Error('unknown rule ' + JSON.stringify(rule))
}

// -- matching ----------------------------------------------------------------------------------------

export type SubscriptionMatch = { id: string; watcher: string; thread: string; event: { event: Record<string, unknown>; rules: string[] } }

/**
 * A subscription's matches among rows, as its subscriber sees them: each event its rules match,
 * once, naming every rule that matched. Its own writes never match, but for its own schedules.
 */
export function matchSubscription(board: Ctx['board'], mount: Mount, sub: Subscription, rows: EventRow[]): SubscriptionMatch[] {
  const ctx = contextFor(board, subscriberOf(sub), mount, Date.now(), [], { set() {}, clear() {} })
  const rules: [string, Matcher][] = []
  for (const [id, rule] of Object.entries(sub.rules)) {
    try {
      rules.push([id, matcherOf(ctx, rule)])
    } catch {
      // A rule that no longer compiles matches nothing.
    }
  }
  const id = subscriptionId(sub.owner, sub.key)
  const out: SubscriptionMatch[] = []
  const nothing: Compiled = { criteria: false, labels: [] }
  for (const row of rows) {
    if (!SUBSCRIBED.has(row.type) || row.message === null) continue
    const facets = JSON.parse(row.facets) as { before: Facet | null; after: Facet | null } | null
    const concerned = facets ? (facets.after ?? facets.before) : null
    if (!facets || !concerned || !ctx.access.readable(concerned.channel)) continue
    const payload = JSON.parse(row.payload) as Record<string, unknown>
    const by = (payload.by as { actor?: string } | undefined)?.actor ?? null
    const own = by === ctx.actor.id
    const matched = rules.filter(([name, test]) => (!own || sub.rules[name] === 'schedules') && test(row, facets, payload, by)).map(([name]) => name)
    if (!matched.length) continue
    const event = eventView(ctx, row, nothing, true, false)
    if (!event) continue
    const message = event.message as { re: string | null; id: string } | undefined
    out.push({ id: id + ':' + row.seq, watcher: id, thread: message ? (message.re ?? message.id) : 'board', event: { event, rules: matched } })
  }
  return out
}

// -- the routes ----------------------------------------------------------------------------------------

type SubscribeBody = { key: string; sink: string; rules: Record<string, Rule>; revision?: number }

const principalOf = (principal: Principal) => ({ id: principal.id, kind: principal.kind, handle: principal.handle, name: principal.name, role: principal.role ?? null })

op('subscribe', (ctx, body: SubscribeBody) => {
  const principal = ctx.caller.principal
  if (!KEY.test(body.key)) throw badRequest('key: 1 to 64 of a-z, 0-9, and . _ / -, starting with a letter or digit')
  const sink = ctx.board.sinks.get(body.sink)
  if (!sink) throw notFound('this board has no sink ' + body.sink + ': its deployment names the sinks it delivers to', 'sink_not_found')
  if (!sinkAllows(sink, principal.id)) throw forbidden('the sink ' + body.sink + " isn't one " + principal.id + ' may deliver to', 'sink_forbidden')
  if (!ctx.access.anywhere('read')) throw forbidden("this token can't read anywhere, so a subscription would see nothing")
  const ids = Object.keys(body.rules)
  if (ids.length === 0) throw badRequest('rules: a subscription has at least one rule')
  if (ids.length > RULES_MAX) throw badRequest('rules: a subscription has at most ' + RULES_MAX + ' rules')
  for (const id of ids) {
    if (!RULE_ID.test(id)) throw badRequest('rules.' + id + ': ids start with a letter and use up to 32 letters, numbers, and hyphens')
    const rule = body.rules[id]!
    if (typeof rule === 'object' && 'ready' in rule && !CHANNEL.test(rule.ready)) throw badRequest('rules.' + id + ': ready takes a channel (work) or a subtree (work/)')
    if (typeof rule === 'object' && 'docs' in rule && !CHANNEL.test(rule.docs)) throw badRequest('rules.' + id + ': docs takes a channel (specs) or a subtree (specs/)')
    try {
      matcherOf(ctx, rule)
    } catch (error) {
      throw badRequest('rules.' + id + ': ' + ((error as Error).message ?? String(error)))
    }
  }
  const owner = principal.id
  const kept: Principal = { ...principal, expiresAt: null }
  const narrow = ctx.caller.narrow
  const hash = sha256(JSON.stringify([principalOf(principal), ctx.caller.profile, narrow, body.sink, ids.sort().map((id) => [id, body.rules[id]])])).slice(0, 32)
  const old = subscriptionOf(ctx, owner, body.key)
  const revision = body.revision ?? null
  if (old && revision !== null && old.revision !== null) {
    if (revision < old.revision) return { subscription: view(old), changed: false, stale: true }
    if (revision === old.revision && old.hash !== hash) throw new WorkbusError(409, 'revision_conflict', body.key + ' is at revision ' + revision + ' with other rules: a change takes a newer revision')
  }
  if (old && old.hash === hash) {
    if (revision !== null && revision !== old.revision) ctx.sql.run('update subscriptions set revision = ? where owner = ? and key = ?', revision, owner, body.key)
    return { subscription: view({ ...old, revision: revision ?? old.revision }), changed: false }
  }
  if (!old && (ctx.sql.one<{ n: number }>('select count(*) as n from subscriptions where owner = ?', owner)?.n ?? 0) >= SUBSCRIPTIONS_MAX)
    throw new WorkbusError(400, 'too_many_subscriptions', owner + ' has ' + SUBSCRIPTIONS_MAX + ' subscriptions: remove one first')
  ctx.sql.run(
    'insert into subscriptions (owner, key, principal, profile, narrow, sink, rules, revision, hash, created, at) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) on conflict (owner, key) do update set principal = excluded.principal, profile = excluded.profile, narrow = excluded.narrow, sink = excluded.sink, rules = excluded.rules, revision = excluded.revision, hash = excluded.hash, at = excluded.at',
    owner, body.key, JSON.stringify(kept), ctx.caller.profile ? JSON.stringify(ctx.caller.profile) : null, narrow ? JSON.stringify(narrow) : null, body.sink, JSON.stringify(body.rules), revision, hash, old?.created ?? ctx.now, ctx.now,
  )
  // A new one sees what comes after; a changed one keeps its place: no gap, and nothing again.
  if (!old) ctx.sql.run('insert into outbox (destination, seq) values (?, ?) on conflict (destination) do update set seq = excluded.seq', subscriptionId(owner, body.key), ctx.board.head)
  const now = subscriptionOf(ctx, owner, body.key)!
  return { subscription: view(now), changed: true, ...(old ? {} : { created: true }) }
})

op('subscriptions', (ctx, query: { prefix?: string }) => {
  const all = ctx.access.everywhere('manage') && !ctx.access.narrowed
  const rows = (all ? subscriptionsOf(ctx) : ctx.sql.all<Row>('select * from subscriptions where owner = ? order by key', ctx.caller.principal.id).map(parse))
    .filter((sub) => query.prefix === undefined || sub.key.startsWith(query.prefix))
  return { subscriptions: rows.map(view) }
}, { read: true })

op('unsubscribe', (ctx, body: { key: string; revision?: number }) => {
  const owner = ctx.caller.principal.id
  const old = subscriptionOf(ctx, owner, body.key)
  if (!old) return { removed: false }
  if (body.revision !== undefined && old.revision !== null && old.revision > body.revision) return { removed: false, stale: true }
  ctx.sql.run('delete from subscriptions where owner = ? and key = ?', owner, body.key)
  const id = subscriptionId(owner, body.key)
  ctx.sql.run('delete from outbox where destination = ?', id)
  const clear = ctx.board.clearMailbox
  if (clear) ctx.after.push(() => clear(ctx.mount.name + ':' + id))
  return { removed: true }
})


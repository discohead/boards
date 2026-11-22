// Read state (design/read-state.md): what's unread for an actor is what reached it since it last
// read, and it didn't write. In a channel, the roots after its cursor there; in a thread it follows,
// the replies that reached it after its cursor there. Mentions count the same way. Read state is
// bookkeeping, in side tables, never the log: marking read writes no event.
//
// Counting never scans history. A channel's unread count is its live roots (channels.threads, less
// read_gone) less what its row says is at or before the cursor (before) and the actor's own after it
// (own). A thread's counts are written when a reply is posted, to each follower but its author.
import { notFound, WorkbusError } from '../errors.ts'
import { cursorOf, ref, type MessageRow } from './core.ts'
import { hooks, op, type Ctx } from './ops.ts'
import { DDL } from './schema.ts'
import { mentionTerms } from './text.ts'

DDL.push(
  'create table if not exists read_channels (channel text not null, actor text not null, seq integer not null, before integer not null default 0, own integer not null default 0, mentions integer not null default 0, at integer not null, primary key (channel, actor)) strict, without rowid',
  'create table if not exists read_threads (actor text not null, root integer not null, channel text not null, seq integer not null, unread integer not null default 0, mentions integer not null default 0, at integer not null, primary key (actor, root)) strict, without rowid',
  'create index if not exists read_threads_root on read_threads (root)',
  // Roots deleted in a channel: its live roots are channels.threads less these.
  'create table if not exists read_gone (channel text primary key, n integer not null) strict, without rowid',
)

// A cursor at 0 is a row from nothing: it has read nothing, as an actor with no row.

/** How far back marking read up to a point may reach: the messages after it it counts once. */
const READ_REACH = 5000

/** The actors a text mentions by ID. A mention counts for those of them a post reached (its followers). */
const mentionIds = (text: string) => new Set(mentionTerms(text).filter((value) => value.includes(':')))

/** Who a post reached and who of them it mentions, from its own message.posted event: as it was written. */
function reach(ctx: Pick<Ctx, 'sql'>, id: number): { followers: string[]; mentioned: Set<string> } | null {
  const [event] = hooks.eventRows(ctx, id - 1, 1, id)
  if (!event || event.seq !== id || event.type !== 'message.posted') return null
  const followers = (JSON.parse(event.facets) as { after?: { followers?: string[] } } | null)?.after?.followers ?? []
  const ids = mentionIds(String((JSON.parse(event.payload) as { text?: unknown }).text ?? ''))
  return { followers, mentioned: new Set(followers.filter((actor) => ids.has(actor))) }
}

const liveRoots = (ctx: Pick<Ctx, 'sql'>, channel: string) =>
  ctx.sql.one<{ n: number }>('select coalesce((select threads from channels where path = ?), 0) - coalesce((select n from read_gone where channel = ?), 0) as n', channel, channel)!.n

/** Adds one to an actor's own roots or mentions in a channel, after its cursor (a row from nothing when it has none). */
function bumpChannel(ctx: Pick<Ctx, 'sql' | 'now'>, channel: string, actor: string, column: 'own' | 'mentions', id: number) {
  ctx.sql.run(
    'insert into read_channels (channel, actor, seq, ' + column + ', at) values (?, ?, 0, 1, ?) on conflict (channel, actor) do update set ' + column + ' = ' + column + ' + (seq < ?)',
    channel, actor, ctx.now, id,
  )
}

/**
 * Whether an actor may hold read state in a post's channel. In a private channel (its parties fixed by
 * the deployment), only a party by ID, or one the board has seen read there (a row of its own in the
 * channel, which only a write it could read makes, or a mark it was let make). Anyone else a post
 * mentions or reaches there gets no row at all; the read-time check stays, for grants that change.
 */
function holds(ctx: Ctx, row: MessageRow, actor: string): boolean {
  const parties = ctx.board.partiesOf(row.channel)
  if (!parties || parties.includes(actor)) return true
  return Boolean(ctx.sql.one('select 1 as there from read_channels where channel = ? and actor = ?', row.channel, actor))
}

// A post: a root counts in its channel for everyone but its author, and a mention for whom it
// mentions; a reply counts for each follower it reaches but its author. After follows.ts has written
// who follows it, so these are the followers its event's facet names.
const posted = hooks.posted
hooks.posted = (ctx, row) => {
  posted(ctx, row)
  const followers = ctx.board.followers(row).filter((actor) => actor !== row.actor && holds(ctx, row, actor))
  const ids = mentionIds(row.text)
  if (row.re === null) {
    if (!row.blind || !ctx.board.partiesOf(row.channel)) bumpChannel(ctx, row.channel, row.actor, 'own', row.id)
    for (const actor of followers) if (ids.has(actor)) bumpChannel(ctx, row.channel, actor, 'mentions', row.id)
    return
  }
  // A reply's author could read where it wrote: in a private channel, the board now knows it.
  if (!row.blind && ctx.board.partiesOf(row.channel)) ctx.sql.run('insert into read_channels (channel, actor, seq, at) values (?, ?, 0, ?) on conflict (channel, actor) do nothing', row.channel, row.actor, ctx.now)
  for (const actor of followers) {
    const mention = ids.has(actor) ? 1 : 0
    ctx.sql.run(
      'insert into read_threads (actor, root, channel, seq, unread, mentions, at) values (?, ?, ?, ?, 1, ?, ?) on conflict (actor, root) do update set unread = unread + 1, mentions = mentions + excluded.mentions',
      actor, row.thread, row.channel, row.id - 1, mention, ctx.now,
    )
  }
}

/** A root leaves a channel's count (deleted, or moved out): every row there moves with it. */
function rootLeaves(ctx: Ctx, row: MessageRow, channel: string, reached: ReturnType<typeof reach>) {
  ctx.sql.run('update read_channels set before = before - 1 where channel = ? and seq >= ?', channel, row.id)
  ctx.sql.run('update read_channels set own = own - 1 where channel = ? and actor = ? and seq < ?', channel, row.actor, row.id)
  for (const actor of reached?.mentioned ?? []) if (actor !== row.actor) ctx.sql.run('update read_channels set mentions = mentions - 1 where channel = ? and actor = ? and seq < ?', channel, actor, row.id)
}

// A delete: a root leaves its channel's live roots; a reply leaves the counts of those it reached.
const deleting = hooks.deleting
hooks.deleting = (ctx, row) => {
  deleting(ctx, row)
  if (row.deleted) return
  const reached = reach(ctx, row.id)
  if (row.re === null) {
    ctx.sql.run('insert into read_gone (channel, n) values (?, 1) on conflict (channel) do update set n = n + 1', row.channel)
    rootLeaves(ctx, row, row.channel, reached)
    return
  }
  for (const actor of reached?.followers ?? []) {
    if (actor === row.actor) continue
    ctx.sql.run('update read_threads set unread = unread - 1, mentions = mentions - ? where actor = ? and root = ? and seq < ?', reached!.mentioned.has(actor) ? 1 : 0, actor, row.thread, row.id)
  }
}

// A doc moved to another channel: its root leaves the old channel's count and joins the new one's.
// channels.threads moved with it (docs.ts); its thread's rows follow it.
const docMoved = hooks.docMoved
hooks.docMoved = (ctx, row, from, to) => {
  docMoved(ctx, row, from, to)
  const reached = reach(ctx, row.id)
  rootLeaves(ctx, row, from, reached)
  ctx.sql.run('update read_channels set before = before + 1 where channel = ? and seq >= ?', to, row.id)
  bumpChannel(ctx, to, row.actor, 'own', row.id)
  for (const actor of reached?.mentioned ?? []) if (actor !== row.actor) bumpChannel(ctx, to, actor, 'mentions', row.id)
  ctx.sql.run('update read_threads set channel = ? where root = ?', to, row.id)
}

// Unfollowing a thread (nothing in it followed any more) marks it read: what the follow brought stops.
const unfollowed = hooks.unfollowed
hooks.unfollowed = (ctx, actor, root) => {
  unfollowed(ctx, actor, root)
  if (ctx.sql.one('select 1 as there from follows where actor = ? and root = ? and following = 1', actor, root)) return
  ctx.sql.run('update read_threads set seq = ?, unread = 0, mentions = 0, at = ? where actor = ? and root = ?', ctx.board.head, ctx.now, actor, root)
}

// -- reading ------------------------------------------------------------------------------------

type ChannelRead = { seq: number; before: number; own: number; mentions: number }
type ThreadRead = { root: number; channel: string; seq: number; unread: number; mentions: number }

const inScope = (scope: string | undefined, path: string) =>
  scope === undefined || (scope.endsWith('/') ? path === scope.slice(0, -1) || path.startsWith(scope) : path === scope)

op('unread', (ctx, query: { channel?: string }) => {
  const actor = ctx.actor.id
  const scope = query.channel
  const threads = ctx.sql
    .all<ThreadRead>('select root, channel, seq, unread, mentions from read_threads where actor = ? and (unread > 0 or mentions > 0) order by root desc', actor)
    .filter((row) => inScope(scope, row.channel) && ctx.access.readable(row.channel))
  const threadMentions = new Map<string, number>()
  for (const row of threads) threadMentions.set(row.channel, (threadMentions.get(row.channel) ?? 0) + row.mentions)
  const rows = ctx.sql.all<{ path: string; live: number } & Partial<ChannelRead>>(
    'select c.path, c.threads - coalesce(g.n, 0) as live, r.seq, r.before, r.own, r.mentions from channels c left join read_gone g on g.channel = c.path left join read_channels r on r.channel = c.path and r.actor = ? order by c.path',
    actor,
  )
  const channels: Record<string, unknown>[] = []
  for (const row of rows) {
    if (!inScope(scope, row.path) || !ctx.access.readable(row.path)) continue
    const unread = Math.max(0, row.live - (row.before ?? 0) - (row.own ?? 0))
    const mentions = Math.max(0, row.mentions ?? 0) + (threadMentions.get(row.path) ?? 0)
    if (unread === 0 && mentions === 0 && row.path !== scope) continue
    channels.push({ channel: row.path, unread, mentions, read: row.seq ? ref(row.seq) : null })
  }
  if (scope !== undefined && !scope.endsWith('/') && ctx.access.readable(scope) && !channels.some((entry) => entry.channel === scope))
    channels.push({ channel: scope, unread: 0, mentions: threadMentions.get(scope) ?? 0, read: null })
  return {
    channels,
    threads: threads.map((row) => ({ thread: ref(row.root), channel: row.channel, unread: Math.max(0, row.unread), mentions: Math.max(0, row.mentions), read: ref(row.seq) })),
    cursor: ref(ctx.board.head),
  }
}, { read: true })

const tooFar = () => new WorkbusError(400, 'read_point_too_far', 'upto reaches back past the newest ' + READ_REACH + ' messages: mark read up to a newer point, or up to now (no upto)')

/** Where a mark moves a cursor: a position on the board, at most its head. */
const pointOf = (ctx: Ctx, upto: string | undefined) => (upto === undefined ? ctx.board.head : Math.min(cursorOf(upto), ctx.board.head))

/** Marks a channel read up to a point: what's after it is counted once, so the row says it again. */
function markChannel(ctx: Ctx, channel: string, upto: string | undefined) {
  if (!ctx.access.readable(channel) || !ctx.sql.one('select 1 as there from channels where path = ?', channel)) throw notFound('channel not found: ' + channel, 'channel_not_found')
  const actor = ctx.actor.id
  const seq = pointOf(ctx, upto)
  const live = liveRoots(ctx, channel)
  let after = 0
  let own = 0
  let mentions = 0
  if (upto !== undefined) {
    const hot = ctx.sql.all<MessageRow>('select * from messages where channel = ? and id > ? order by id limit ?', channel, seq, READ_REACH + 1)
    const archived = hooks.archivedRoots(ctx, channel, seq, READ_REACH + 1)
    if (hot.length > READ_REACH || archived.length > READ_REACH) throw tooFar()
    const roots = [...hot.filter((row) => row.re === null), ...archived]
    for (const root of roots) {
      if (root.deleted) continue
      after++
      if (root.actor === actor) own++
      // Only a root that mentions the actor now, or was edited since, can have mentioned it when posted.
      else if ((root.edited_at !== null || mentionIds(root.text).has(actor)) && reach(ctx, root.id)?.mentioned.has(actor)) mentions++
    }
  }
  ctx.sql.run(
    'insert into read_channels (channel, actor, seq, before, own, mentions, at) values (?, ?, ?, ?, ?, ?, ?) on conflict (channel, actor) do update set seq = excluded.seq, before = excluded.before, own = excluded.own, mentions = excluded.mentions, at = excluded.at',
    channel, actor, seq, live - after, own, mentions, ctx.now,
  )
  return { channel, unread: after - own, mentions, read: ref(seq) }
}

/** Marks a thread read up to a point: the replies after it that reached the actor, counted once. */
function markThread(ctx: Ctx, id: string, upto: string | undefined) {
  const named = ctx.board.readable(id, ctx.access)
  const root = named.re === null ? named : ctx.board.message(named.re)!
  const actor = ctx.actor.id
  const seq = pointOf(ctx, upto)
  let unread = 0
  let mentions = 0
  if (upto !== undefined) {
    const replies = ctx.sql.all<MessageRow>('select * from messages where thread = ? and re is not null and id > ? order by id limit ?', root.id, seq, READ_REACH + 1)
    if (replies.length > READ_REACH) throw tooFar()
    for (const reply of replies) {
      if (reply.deleted || reply.actor === actor) continue
      const reached = reach(ctx, reply.id)
      if (!reached?.followers.includes(actor)) continue
      unread++
      if (reached.mentioned.has(actor)) mentions++
    }
  }
  ctx.sql.run(
    'insert into read_threads (actor, root, channel, seq, unread, mentions, at) values (?, ?, ?, ?, ?, ?, ?) on conflict (actor, root) do update set channel = excluded.channel, seq = excluded.seq, unread = excluded.unread, mentions = excluded.mentions, at = excluded.at',
    actor, root.id, root.channel, seq, unread, mentions, ctx.now,
  )
  return { thread: ref(root.id), channel: root.channel, unread, mentions, read: ref(seq) }
}

op('markRead', (ctx, body: { channel?: string; thread?: string; upto?: string }) =>
  body.thread !== undefined ? markThread(ctx, body.thread, body.upto) : markChannel(ctx, body.channel!, body.upto))

// Archived channels (issue #15): an owner (manage there) archives a channel or a subtree, and
// unarchives it. The history stays: archiving is an event, and nothing is removed. An archived
// channel leaves GET /channels (unless ?archived=true) and the unread counts, takes no new posts
// (a sync's imports still land: the platform is the source), and wakes see nothing in it. It isn't
// archival (archive.ts), which moves cold history to R2: an archived channel stays hot or cold as
// any other. A pattern is a channel (eng) or a subtree (checks/), as grants write them.
import { WorkbusError, badRequest, forbidden } from '../errors.ts'
import { iso, type MessageRow } from './core.ts'
import { hooks, op, type Ctx } from './ops.ts'
import { DDL } from './schema.ts'

DDL.push(
  'create table if not exists channel_archives (pattern text primary key, at integer not null, by text not null) strict, without rowid',
  // What's gone from each channel's counts: deleted messages, and of them roots. Live is channels' less these.
  'create table if not exists channel_gone (channel text primary key, messages integer not null default 0, roots integer not null default 0) strict, without rowid',
  // A board from before this table: its deletes so far, once (hot history: threads cold on R2 count as they were).
  "insert into channel_gone (channel, messages, roots) select channel, count(*), sum(re is null) from messages where deleted = 1 and not exists (select 1 from meta where key = 'channel_gone') group by channel",
  "insert into meta (key, value) values ('channel_gone', '1') on conflict (key) do nothing",
)

const CHANNEL = /^[a-z0-9][a-z0-9_-]*(\/[a-z0-9][a-z0-9_-]*)*$/

export type Archived = { pattern: string; at: number; by: string }

/** Every archived pattern, by pattern. */
export function archives(ctx: Pick<Ctx, 'sql'>): Map<string, Archived> {
  return new Map(ctx.sql.all<Archived>('select pattern, at, by from channel_archives').map((row) => [row.pattern, row]))
}

type Parties = (channel: string) => readonly string[] | null
const sameParties = (parties: Parties, a: string, b: string) => JSON.stringify(parties(a)) === JSON.stringify(parties(b))

/**
 * Whether a subtree pattern reaches a channel under it. A private channel only by a pattern with its
 * own parties (dm/ada/ for dm/ada/x): so archiving dm/ archives no one's DM, and whether one is there
 * tells no one who isn't a party anything.
 */
export const reaches = (parties: Parties, pattern: string, channel: string) => !parties(channel) || sameParties(parties, pattern.replace(/\/$/, ''), channel)

/** What archives a channel, given the patterns: the channel itself, or a subtree it's in (its own included) that reaches it. */
export function archivedIn(ctx: Pick<Ctx, 'board'>, patterns: ReadonlyMap<string, Archived>, channel: string): Archived | null {
  if (patterns.size === 0) return null
  const exact = patterns.get(channel)
  if (exact) return exact
  const parties: Parties = (path) => ctx.board.partiesOf(path)
  const parts = channel.split('/')
  for (let i = 1; i <= parts.length; i++) {
    const pattern = parts.slice(0, i).join('/') + '/'
    const found = patterns.get(pattern)
    if (found && reaches(parties, pattern, channel)) return found
  }
  return null
}

/** What archives a channel, or null. */
export const archivedBy = (ctx: Pick<Ctx, 'sql' | 'board'>, channel: string): Archived | null => archivedIn(ctx, archives(ctx), channel)

export const archivedView = (archived: Archived) => ({ pattern: archived.pattern, at: iso(archived.at), by: archived.by })

/** A write to an archived channel, refused. */
export function refuseArchived(ctx: Pick<Ctx, 'sql' | 'board'>, channel: string) {
  const archived = archivedBy(ctx, channel)
  if (archived) throw new WorkbusError(409, 'channel_archived', channel + ' is archived' + (archived.pattern === channel ? '' : ' (with ' + archived.pattern + ')') + ': unarchive it to post there', { hint: 'POST /channels/unarchive with { "path": "' + archived.pattern + '" }, as someone with manage there' })
}

/** A channel's live counts: what's there less what was deleted. */
export function liveCounts(ctx: Pick<Ctx, 'sql'>, row: { path: string; messages: number; threads: number }) {
  const gone = ctx.sql.one<{ messages: number; roots: number }>('select messages, roots from channel_gone where channel = ?', row.path)
  return { messages: Math.max(0, row.messages - (gone?.messages ?? 0)), threads: Math.max(0, row.threads - (gone?.roots ?? 0)) }
}

// A delete leaves its channel's live counts.
const deleting = hooks.deleting
hooks.deleting = (ctx, row) => {
  deleting(ctx, row)
  if (row.deleted) return
  ctx.sql.run('insert into channel_gone (channel, messages, roots) values (?, 1, ?) on conflict (channel) do update set messages = messages + 1, roots = roots + excluded.roots', row.channel, row.re === null ? 1 : 0)
}

// A doc that moves takes what was deleted in its thread with it (docs.ts moves its counts).
const docMoved = hooks.docMoved
hooks.docMoved = (ctx, row: MessageRow, from, to) => {
  docMoved(ctx, row, from, to)
  const gone = ctx.sql.one<{ n: number }>('select count(*) as n from messages where thread = ? and deleted = 1', row.id)!.n
  if (gone === 0) return
  ctx.sql.run('update channel_gone set messages = max(messages - ?, 0) where channel = ?', gone, from)
  ctx.sql.run('insert into channel_gone (channel, messages, roots) values (?, ?, 0) on conflict (channel) do update set messages = messages + excluded.messages', to, gone)
}

// -- the routes -------------------------------------------------------------------------------------

/** A pattern from a path: a channel, or a subtree with its trailing slash. */
function patternOf(path: string): { pattern: string; channel: string; subtree: boolean } {
  const subtree = path.endsWith('/')
  const channel = subtree ? path.slice(0, -1) : path
  if (!CHANNEL.test(channel)) throw badRequest("path: a channel (eng) or a channel and its subtree (checks/), not " + path)
  return { pattern: path, channel, subtree }
}

const under = (pattern: string, channel: string) => (pattern.endsWith('/') ? channel === pattern.slice(0, -1) || channel.startsWith(pattern) : channel === pattern)

/** manage where the pattern reaches: the channel, and each channel the board has under a subtree. */
function mayManage(ctx: Ctx, pattern: string, channel: string, subtree: boolean): string[] {
  const reached = subtree
    ? ctx.sql.all<{ path: string }>('select path from channels where path = ? or substr(path, 1, ?) = ? order by path', channel, pattern.length, pattern).map((row) => row.path).filter((path) => reaches((c) => ctx.board.partiesOf(c), pattern, path))
    : [channel]
  for (const path of new Set([channel, ...reached])) if (!ctx.access.can('manage', path)) throw forbidden("this token can't archive " + pattern + ': archiving needs manage in ' + path)
  return reached
}

op('archiveChannel', (ctx, body: { path: string }) => {
  const { pattern, channel, subtree } = patternOf(body.path)
  const reached = mayManage(ctx, pattern, channel, subtree)
  const already = archivedBy(ctx, channel)
  if (ctx.sql.one('select 1 as there from channel_archives where pattern = ?', pattern)) return { archived: archivedView(already!), channels: reached.length, changed: false }
  ctx.board.seen(ctx.actor, ctx.now)
  ctx.sql.run('insert into channel_archives (pattern, at, by) values (?, ?, ?)', pattern, ctx.now, ctx.author.actor)
  ctx.board.append('channel.archived', { channel, subtree, by: ctx.author }, { at: ctx.now })
  return { archived: archivedView({ pattern, at: ctx.now, by: ctx.author.actor }), channels: reached.length, changed: true }
})

op('unarchiveChannel', (ctx, body: { path: string }) => {
  const { pattern, channel, subtree } = patternOf(body.path)
  mayManage(ctx, pattern, channel, subtree)
  // The pattern, and under a subtree every pattern inside it.
  const removed = [...archives(ctx).keys()].filter((known) => known === pattern || (subtree && under(pattern, known.replace(/\/$/, ''))))
  if (removed.length) {
    ctx.board.seen(ctx.actor, ctx.now)
    for (const known of removed.sort()) {
      ctx.sql.run('delete from channel_archives where pattern = ?', known)
      ctx.board.append('channel.unarchived', { channel: known.replace(/\/$/, ''), subtree: known.endsWith('/'), by: ctx.author }, { at: ctx.now })
    }
  }
  if (removed.length) hooks.unarchived(ctx, removed)
  // What a wider pattern still archives: unarchiving checks/a leaves it archived by checks/.
  const still = archivedBy(ctx, channel)
  return { unarchived: removed.sort(), changed: removed.length > 0, ...(still ? { still: archivedView(still) } : {}) }
})

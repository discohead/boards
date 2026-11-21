// Follows: who hears about what (design/follows.md). An actor follows a thread, or in a doc's thread
// a discussion (a top-level comment and the replies under it). Starting a thread follows it;
// replying in one, or being mentioned there, follows it (in a doc, the discussion). An event about a
// message carries its followers in its facet, written with the event, and the for filter matches an
// actor among them or among its mentions, unless the actor wrote it. Follows are bookkeeping: a
// table, not the log.
import { badRequest } from '../errors.ts'
import { authorize, ref, type MessageRow } from './core.ts'
import { hooks, op, type Ctx } from './ops.ts'
import { DDL } from './schema.ts'
import { mentionTerms } from './text.ts'

DDL.push(
  // discussion is 0 for the whole thread, else the top-level comment that heads it.
  'create table if not exists follows (actor text not null, root integer not null, discussion integer not null default 0, cause text not null, following integer not null, at integer not null, primary key (actor, root, discussion)) strict, without rowid',
  'create index if not exists follows_unit on follows (root, discussion) where following = 1',
)

export type Unit = { root: number; discussion: number }

/** What a message is in, for following: its thread, or in a doc's thread, its discussion. */
export const unitOf = (ctx: Pick<Ctx, 'board'>, row: MessageRow): Unit => ctx.board.unitOf(row)

/** Follows a unit for an actor. Taking part again follows again; a follow already on keeps its cause. */
export function follow(ctx: Pick<Ctx, 'sql' | 'now'>, actor: string, unit: Unit, cause: string, following = true) {
  ctx.sql.run(
    'insert into follows (actor, root, discussion, cause, following, at) values (?, ?, ?, ?, ?, ?) on conflict (actor, root, discussion) do update set cause = case when follows.following = 1 and excluded.following = 1 then follows.cause else excluded.cause end, at = case when follows.following = 1 and excluded.following = 1 then follows.at else excluded.at end, following = excluded.following',
    actor, unit.root, unit.discussion, cause, following ? 1 : 0, ctx.now,
  )
}

/** The actors a message mentions by ID, as it settled them. */
const mentioned = (ctx: Pick<Ctx, 'board'>, text: string) => mentionTerms(text).filter((value) => value.includes(':') && ctx.board.actor(value) !== null)

// A post follows what it's in for its author, and for whoever it mentions (before its event is written, so its facet has them).
hooks.posted = (ctx, row) => {
  if (row.blind) return
  const unit = unitOf(ctx, row)
  follow(ctx, row.actor, unit, row.re === null ? 'created' : 'commented')
  for (const actor of mentioned(ctx, row.text)) if (actor !== row.actor) follow(ctx, actor, unit, 'mentioned')
}

op('follow', (ctx, body: { id: string; on?: boolean }) => {
  const row = ctx.board.readable(body.id, ctx.access)
  authorize(ctx.access, 'read', row.channel)
  const unit = unitOf(ctx, row)
  const on = body.on !== false
  follow(ctx, ctx.actor.id, unit, on ? 'followed' : 'unfollowed', on)
  return { following: on, thread: ref(unit.root), discussion: unit.discussion ? ref(unit.discussion) : null }
})

op('follows', (ctx, query: { limit?: number }) => {
  const limit = query.limit ?? 100
  if (limit < 1 || limit > 500) throw badRequest('limit: 1 to 500')
  const rows = ctx.sql.all<{ root: number; discussion: number; cause: string; at: number }>('select root, discussion, cause, at from follows where actor = ? and following = 1 order by at desc limit ?', ctx.actor.id, limit * 2)
  const follows: Record<string, unknown>[] = []
  for (const row of rows) {
    const root = ctx.board.message(row.root)
    if (!root || root.deleted || !ctx.access.readable(root.channel)) continue
    follows.push({ thread: ref(row.root), discussion: row.discussion ? ref(row.discussion) : null, channel: root.channel, cause: row.cause, at: new Date(row.at).toISOString() })
    if (follows.length === limit) break
  }
  return { follows }
}, { read: true })

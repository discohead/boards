// The operation registry: every protocol method the Ledger answers, by name. An operation runs in
// one synchronous transaction with a context: the board, the caller, what it may do, and now.
import type { Access } from './access.ts'
import { actorOf, authorOf, type ActorRecord, type Author, type Board, type Caller, type MessageRow } from './core.ts'
import type { Compiled } from './messages.ts'
import type { Sql } from './sql.ts'

export type Mount = { name: string; origin: string; url: string }

export type Ctx = {
  board: Board
  sql: Sql
  caller: Caller
  author: Author
  actor: ActorRecord
  access: Access
  now: number
  mount: Mount
  /** What the Ledger does after the transaction commits: delivery, timers, rings. */
  after: (() => void | Promise<void>)[]
  /** Arms a timer (one alarm multiplexes all). */
  timer(kind: string, ref: string, due: number): void
  clearTimer(kind: string, ref: string): void
}

export type Op = (ctx: Ctx, input: any) => unknown
export const OPS: Record<string, Op> = {}
/** Operations that only read: run without a write transaction's bookkeeping. */
export const READS = new Set<string>()

/** Timers by kind: what the alarm runs when one is due. Each part registers its own. Here, not in
 * ledger.ts, so a domain module can register at load: ledger.ts imports the domains before its body runs. */
export const TIMERS: Record<string, (ctx: Ctx, ref: string) => void> = {}

/** What a step outside any transaction gets: the board, its storage and bindings, and its timers. */
export type Runtime = { board: Board; sql: Sql; storage: DurableObjectStorage; env: Record<string, unknown>; mount: Mount; timer(kind: string, ref: string, due: number): void }

/** Timers whose step awaits I/O (R2): the alarm runs each outside a transaction, and each re-arms itself. */
export const ASYNC_TIMERS: Record<string, (rt: Runtime, ref: string) => Promise<void>> = {}

export type ThreadRow = { root: number; last: number; replies: number; channel: string }
export type EventRow = { seq: number; type: string; thread: number | null; message: number | null; actor: string | null; at: number; payload: string; facets: string }

export function op(name: string, fn: Op, options: { read?: boolean } = {}) {
  OPS[name] = fn
  if (options.read) READS.add(name)
}

/** What other parts of the board add to messages and their writes. Each part sets its own. */
export const hooks = {
  /** A root's task view, or undefined when it isn't a task. */
  taskView: (_ctx: Pick<Ctx, 'board' | 'sql' | 'now'>, _root: number, _at?: number): unknown => undefined,
  /** A task root was edited by someone (in the edit's transaction, after the edit). */
  rootEdited: (_ctx: Ctx, _root: number): void => {},
  /** A task root is about to be deleted (in the delete's transaction, before the delete). */
  rootDeleted: (_ctx: Ctx, _root: number): void => {},
  /** Checks a text's blocks against the registry: throws 400 invalid_block / schema_not_found. */
  checkBlocks: (_ctx: Ctx, _text: string): void => {},
  /** Files a write carries, as the board stored them: throws 404 attachment_not_found. */
  attachments: (_ctx: Ctx, ids: string[]): unknown[] => {
    if (ids.length) throw Object.assign(new Error('no files'), { status: 501, code: 'no_files', message: 'this board keeps no files' })
    return []
  },
  /** A new root's sync targets, recorded in the post's own transaction: thread.synced events. */
  syncTargets: (_ctx: Ctx, _root: number, _thread: string, _targets: { target: string; kind?: 'channel' | 'thread' }[]): void => {},
  /** What a part adds to a message's view (a doc root's doc, a doc comment's section). */
  viewExtras: (_ctx: Pick<Ctx, 'board' | 'sql' | 'now'>, _row: MessageRow): Record<string, unknown> | undefined => undefined,
  /** Whether a root is a doc (docs.ts): its body changes through editDoc, not edit. */
  docRoot: (_ctx: Pick<Ctx, 'sql'>, _root: number): boolean => false,
  /** A task is about to complete (in the completion's transaction): a part may refuse it by throwing. */
  taskCompleting: (_ctx: Ctx, _root: number): void => {},
  /** Pending schedules that reply in a thread, for its view. */
  threadSchedules: (_ctx: Ctx, _root: number): unknown[] | undefined => [],
  // Archived history (archive.ts): each says where an op is about to read what may be in R2, so the
  // Ledger can load it and run the op again. The defaults are a board with nothing archived.
  /** The board log's events after a position (up to one, when given), oldest first, at most limit. */
  eventRows: (ctx: Pick<Ctx, 'sql'>, after: number, limit: number, upto?: number): EventRow[] =>
    ctx.sql.all<EventRow>('select * from events where seq > ? and seq <= ? order by seq limit ?', after, upto ?? Number.MAX_SAFE_INTEGER, limit),
  /**
   * The threads /threads lists, in its order: by latest activity, newest first (before a cursor,
   * when one is given), or oldest first after a position. Each call answers the next batch.
   */
  threadScan: (ctx: Pick<Ctx, 'sql'>, after: number | null, before: { at: number; id: number } | null): ((batch: number) => ThreadRow[]) => {
    let offset = 0
    return (batch) => {
      const rows = after !== null
        ? ctx.sql.all<ThreadRow>('select root, last, replies, channel from threads where last > ? order by last, root limit ? offset ?', after, batch, offset)
        : before
          ? ctx.sql.all<ThreadRow>('select root, last, replies, channel from threads where (last < ? or (last = ? and root < ?)) order by last desc, root desc limit ? offset ?', before.at, before.at, before.id, batch, offset)
          : ctx.sql.all<ThreadRow>('select root, last, replies, channel from threads order by last desc, root desc limit ? offset ?', batch, offset)
      offset += rows.length
      return rows
    }
  },
  /** In a filtered scan: whether an archived thread matches (undefined when it isn't archived). */
  coldMatch: (_ctx: Ctx, _root: number, _compiled: Compiled): boolean | undefined => undefined,
  /** A client ID (or a root's thread key) about to be looked up. */
  keyed: (_ctx: Ctx, _key: string): void => {},
  /** A channel's page as the messages table answered it, and the page with archived threads' messages in it. */
  channelRows: (_ctx: Ctx, _channel: string, _after: number | null, _limit: number, rows: MessageRow[]): MessageRow[] => rows,
}

export function contextFor(board: Board, caller: Caller, mount: Mount, now: number, after: Ctx['after'], timers: { set(kind: string, ref: string, due: number): void; clear(kind: string, ref: string): void }): Ctx {
  return {
    board,
    sql: board.sql,
    caller,
    author: authorOf(caller),
    actor: actorOf(caller),
    access: board.access(caller),
    now,
    mount,
    after,
    timer: (kind, ref, due) => timers.set(kind, ref, due),
    clearTimer: (kind, ref) => timers.clear(kind, ref),
  }
}

/** The view options for a context: its access, and task views. */
export const viewOptions = (ctx: Ctx) => ({ access: ctx.access, taskView: (root: number) => hooks.taskView(ctx, root), extras: (row: MessageRow) => hooks.viewExtras(ctx, row) })
export const viewOf = (ctx: Ctx, id: number) => {
  const row = ctx.board.message(id)
  return row ? ctx.board.view(row, viewOptions(ctx)) : null
}
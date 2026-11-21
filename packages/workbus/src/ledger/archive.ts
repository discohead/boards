// Archival: a board's history grows far past what one Durable Object should hold hot, and every
// read answers as it did. Two tiers, both in R2 (binding FILES):
//
// - Sealed segments. The log's old events, in fixed ranges of seq, go to
//   boards/<board>/segments/<first>-<last> (gzipped NDJSON, one event row a line), written once,
//   and are listed in segments in the same transaction that deletes their rows.
// - Cold threads. A thread with no activity for a while, no open task, no pending schedule, no
//   sync, and nothing a watcher still has to take, has its messages, its terms (but files, ^id, and links, k:id),
//   and its task views (but the latest) moved to boards/<board>/threads/<root>.json. What stays
//   hot is what a listing needs: its threads row, its root and last messages (cold_rows), what
//   its messages match on but their text (cold_facets), its client IDs by hash, and who wrote where.
//
// An op is synchronous, in one transaction, and can't await R2. So archived history faults: a run
// that needs what's only in R2 records it, the Ledger throws the run away (a write's transaction
// rolls back), loads it, and runs the op again. Loading is one of three things:
// - a segment, read into memory (the feed);
// - a thread, read into memory and not restored: reads that list or search (threads, tasks,
//   channel pages, the feed) see it in place, in parallel, and a listing never restores anything;
// - a thread put back in its tables: GET /messages/:id, and every write, which so always finds
//   the thread back first. A thread a call put back isn't archived again until that call ends.
// Listings over cold threads answer from SQLite: a thread's row from cold_rows, a filter from
// cold_facets; only a text search, or re naming a reply, reads the threads it passes from R2.
// The Ledger, not the Gateway, reads R2: access, the fault, and the caches are in one place, and
// the input gate is open while it waits, so other requests go on.
//
// The work runs under the alarm, in bounded steps (one segment, or a batch of threads), each its
// own transaction after its R2 writes are confirmed.
import { WorkbusError, forbidden } from '../errors.ts'
import type { Board, Facet, MessageRow } from './core.ts'
import { matches, postMessage, type Compiled } from './messages.ts'
import { ASYNC_TIMERS, hooks, op, READS, type Ctx, type EventRow, type Runtime, type ThreadRow } from './ops.ts'
import type { Sql } from './sql.ts'
import { mentionTerms } from './text.ts'
// Its taskView hook is wrapped below, so it loads first.
import './tasks.ts'

// -- configuration -------------------------------------------------------------------------------

export type ArchiveConfig = {
  enabled: boolean
  /** Events older than this are sealed (the log's hot window). */
  sealAfterMs: number
  /** Threads with no activity for this long go cold. */
  coldAfterMs: number
  /** Events a segment holds. */
  segment: number
  /** Events at the head that are never sealed. */
  keep: number
  /** How often a pass runs when the last one found nothing to do. */
  everyMs: number
  /** Threads a step moves at most. */
  stepThreads: number
  /** The pause between steps while there's work. */
  pauseMs: number
  /** Threads cold this long have their summaries frozen into R2 pages: nothing of them stays hot. */
  freezeAfterMs: number
  /** Threads a frozen page holds. */
  pageThreads: number
}

const DAY = 24 * 60 * 60 * 1000
export const ARCHIVE_DEFAULTS: ArchiveConfig = { enabled: true, sealAfterMs: 30 * DAY, coldAfterMs: 90 * DAY, segment: 1000, keep: 1000, everyMs: 6 * 60 * 60 * 1000, stepThreads: 50, pauseMs: 0, freezeAfterMs: 30 * DAY, pageThreads: 256 }
const ENV_KEYS: Record<Exclude<keyof ArchiveConfig, 'enabled'>, string> = {
  sealAfterMs: 'ARCHIVE_SEAL_AFTER_MS', coldAfterMs: 'ARCHIVE_COLD_AFTER_MS', segment: 'ARCHIVE_SEGMENT', keep: 'ARCHIVE_KEEP', everyMs: 'ARCHIVE_EVERY_MS', stepThreads: 'ARCHIVE_STEP_THREADS', pauseMs: 'ARCHIVE_PAUSE_MS', freezeAfterMs: 'ARCHIVE_FREEZE_AFTER_MS', pageThreads: 'ARCHIVE_PAGE_THREADS',
}
const LIMITS: Record<Exclude<keyof ArchiveConfig, 'enabled'>, [number, number]> = {
  sealAfterMs: [0, 100 * 365 * DAY], coldAfterMs: [0, 100 * 365 * DAY], segment: [16, 100_000], keep: [1, 10_000_000], everyMs: [50, 30 * DAY], stepThreads: [1, 1000], pauseMs: [0, 60 * 60 * 1000], freezeAfterMs: [0, 100 * 365 * DAY], pageThreads: [1, 4096],
}

/** The board's archival settings: the deployment's (env), then the board's own (meta). */
export function configOf(sql: Sql, env: Record<string, unknown>): ArchiveConfig {
  const out: ArchiveConfig = { ...ARCHIVE_DEFAULTS }
  if (String(env.ARCHIVE ?? '').toLowerCase() === 'off') out.enabled = false
  for (const [key, name] of Object.entries(ENV_KEYS) as [keyof typeof ENV_KEYS, string][]) {
    const value = Number(env[name])
    if (env[name] !== undefined && env[name] !== '' && Number.isFinite(value)) out[key] = clamp(key, value)
  }
  const own = sql.one<{ value: string }>("select value from meta where key = 'archive'")
  if (own) Object.assign(out, JSON.parse(own.value) as Partial<ArchiveConfig>)
  return out
}
const clamp = (key: keyof typeof LIMITS, value: number) => Math.min(LIMITS[key][1], Math.max(LIMITS[key][0], Math.floor(value)))

// -- per-board state -------------------------------------------------------------------------------

type Segment = { first: number; last: number; rows: Map<number, EventRow>; bytes: number }
/** A cold thread read from R2 into memory, as it was when it went cold (its fingerprint). */
type Overlay = { root: number; fingerprint: string; rows: Map<number, MessageRow>; list: MessageRow[]; views: [number, string][]; bytes: number; at: number }
/** One call: whether its runs read archived threads in place, and what it holds while it runs. */
export type Session = { reading: boolean; restored: Set<number>; read: Set<number>; bytes: number; pages: Set<number>; pageRounds: number }
type State = {
  faults: { restore: Set<number>; read: Set<number>; segments: Set<number>; pages: Set<number> }
  /** The session whose run is going on (runs are synchronous), and every open one. */
  run: Session | null
  sessions: Set<Session>
  /** Sealed segments read back, oldest use first. */
  cache: Map<number, Segment>
  cacheBytes: number
  /** Cold threads read back, oldest use first; one a session reads is kept until it ends. */
  overlay: Map<number, Overlay>
  overlayBytes: number
  /** Threads a call put back: not archived again until it ends. */
  pinned: Map<number, number>
  /** The frozen pages' index (frozen_pages), and pages read back, oldest use first. */
  pages: PageMeta[] | null
  pageCache: Map<number, Page>
  pageBytes: number
  sealed: number | null
  cold: number | null
  armed: boolean
  /** Since this instance started: runs thrown away, and what they loaded. */
  loads: { rounds: number; restored: number; read: number; segments: number; pages: number }
}
const CACHE_BYTES = 48 * 1024 * 1024
const OVERLAY_BYTES = 32 * 1024 * 1024
const PAGE_BYTES = 32 * 1024 * 1024
/** Frozen pages a run asks for at once, doubled each round of a call: 1, 2, 4, ... */
const PAGES_AT_ONCE = 16
/** What one call may read of archived threads into memory: past it, the board answers 503. */
const SESSION_BYTES = 64 * 1024 * 1024
const WIDTH = 32
const MAX_ROUNDS = 16
const states = new WeakMap<Board, State>()

function stateOf(board: Board): State {
  let state = states.get(board)
  if (!state) {
    state = {
      faults: { restore: new Set(), read: new Set(), segments: new Set(), pages: new Set() }, run: null, sessions: new Set(), cache: new Map(), cacheBytes: 0, overlay: new Map(), overlayBytes: 0, pinned: new Map(),
      pages: null, pageCache: new Map(), pageBytes: 0, sealed: null, cold: null, armed: false, loads: { rounds: 0, restored: 0, read: 0, segments: 0, pages: 0 },
    }
    states.set(board, state)
    board.miss = (id) => missed(board, id)
  }
  return state
}

/** The highest sealed position (0 when nothing is). */
function sealedTop(board: Board): number {
  const state = stateOf(board)
  state.sealed ??= board.sql.one<{ last: number | null }>('select max(last) as last from segments')?.last ?? 0
  return state.sealed
}
function coldCount(board: Board): number {
  const state = stateOf(board)
  state.cold ??= board.sql.one<{ n: number }>("select count(*) as n from cold_threads where state = 'cold'")?.n ?? 0
  return state.cold
}
const coldOf = (sql: Sql, root: number) => sql.one<{ fingerprint: string; last_id: number; channel: string }>("select fingerprint, last_id, channel from cold_threads where root = ? and state = 'cold'", root)
const isCold = (sql: Sql, root: number) => coldOf(sql, root) !== null

// -- sessions and faults: what a run needs that's in R2 ---------------------------------------------------

/** Ops that read inside a thread: they bring it back, like a write. Every other read sees cold threads in place. */
const RESTORING_READS = new Set(['message'])

/** The error a call ends with when what it needs of the archive doesn't load: rare, an overload. */
export const archiveBusy = () => new WorkbusError(503, 'archive_unavailable', "this read needs the board's archived history, and it didn't load in time: try again")
export const ARCHIVE_ROUNDS = MAX_ROUNDS

/** A call's session, by its method: null for the board's own timers, which write. */
export function openSession(rt: Runtime, method: string | null): Session {
  prepare(rt)
  const session: Session = { reading: method !== null && READS.has(method) && !RESTORING_READS.has(method), restored: new Set(), read: new Set(), bytes: 0, pages: new Set(), pageRounds: 0 }
  stateOf(rt.board).sessions.add(session)
  return session
}
/** Before each run of a call: no faults yet, and this session's. */
export function beginRun(board: Board, session: Session) {
  const state = stateOf(board)
  state.faults.restore.clear()
  state.faults.read.clear()
  state.faults.segments.clear()
  state.faults.pages.clear()
  state.run = session
}
export function faulted(board: Board): boolean {
  const { faults } = stateOf(board)
  return faults.restore.size > 0 || faults.read.size > 0 || faults.segments.size > 0 || faults.pages.size > 0
}
/** A run's value, or the throw that sends it round again (a write's transaction rolls back). */
export function unlessFaulted<T>(board: Board, value: T): T {
  if (faulted(board)) throw archiveBusy()
  return value
}
/** When a call ends: what it put back may go cold again, and what it read may leave memory. */
export function closeSession(board: Board, session: Session) {
  const state = stateOf(board)
  for (const root of session.restored) {
    const count = (state.pinned.get(root) ?? 1) - 1
    if (count <= 0) state.pinned.delete(root)
    else state.pinned.set(root, count)
  }
  state.sessions.delete(session)
  if (state.run === session) state.run = null
  evictOverlay(state)
  evictPages(state)
}

/** A cold thread a run needs: read in place when it only reads, put back otherwise. */
function need(board: Board, root: number) {
  const state = stateOf(board)
  if (state.run?.reading) state.faults.read.add(root)
  else state.faults.restore.add(root)
}

/** A cold thread in memory, as it is now (its fingerprint still the stub's): kept for this session. */
function overlayOf(board: Board, root: number, fingerprint?: string): Overlay | null {
  const state = stateOf(board)
  const entry = state.overlay.get(root)
  if (!entry) return null
  const current = fingerprint ?? coldOf(board.sql, root)?.fingerprint
  // A frozen thread changes only by coming back: what was read before that is stale.
  if (current === undefined ? !frozenValid(board.sql, entry.at - 1, root) : entry.fingerprint !== current) return null
  state.overlay.delete(root)
  state.overlay.set(root, entry)
  state.run?.read.add(root)
  return entry
}

/** A summary row of a cold thread (its root, its last message), kept hot for listings. */
function summaryRow(sql: Sql, id: number): MessageRow | null {
  const found = sql.one<{ row: string }>("select r.row from cold_rows r join cold_threads c on c.root = r.root and c.state = 'cold' where r.id = ?", id)
  return found ? unpackRow(sql, found.row) : null
}
/** A row as cold_rows keeps it: its values in order, after the ID of its column list (meta), and no text_lower. */
const columnLists = new Map<number, string[]>()
function packRow(sql: Sql, row: MessageRow): string {
  const columns = Object.keys(row).filter((column) => column !== 'text_lower')
  const id = hashKey(columns.join(','))
  if (!columnLists.has(id)) {
    sql.run("insert into meta (key, value) values (?, ?) on conflict (key) do nothing", 'cold_columns:' + id, JSON.stringify(columns))
    columnLists.set(id, columns)
  }
  return JSON.stringify([id, ...columns.map((column) => (row as unknown as Record<string, unknown>)[column])])
}
function unpackRow(sql: Sql, text: string): MessageRow {
  const parsed = JSON.parse(text) as [number, ...unknown[]] | MessageRow
  if (!Array.isArray(parsed)) return { ...parsed, text_lower: parsed.text.toLowerCase() } as MessageRow
  const [id, ...values] = parsed
  let columns = columnLists.get(id)
  if (!columns) {
    columns = JSON.parse(sql.one<{ value: string }>('select value from meta where key = ?', 'cold_columns:' + id)!.value) as string[]
    columnLists.set(id, columns)
  }
  const row = Object.fromEntries(columns.map((column, i) => [column, values[i]])) as unknown as MessageRow
  return { ...row, text_lower: row.text.toLowerCase() } as MessageRow
}

/** A message ID with no row: a reader gets a cold thread's row in place; anything else faults it back. */
function missed(board: Board, id: number): MessageRow | null {
  if (!Number.isSafeInteger(id) || id < 1 || id > board.head || !archivedAny(board)) return null
  const state = stateOf(board)
  const reading = state.run?.reading === true
  if (reading) {
    const summary = summaryRow(board.sql, id) ?? frozenRow(board, id)
    if (summary) return summary
  }
  const root = rootOf(board, id)
  if (root === null || root === undefined) return null
  if (reading) {
    const entry = overlayOf(board, root)
    if (entry) return entry.rows.get(id) ?? null
    // A frozen thread's root or last message is in its page: when its roots pin the page down (to
    // one or two), the page is read, which serves its neighbours too, rather than the thread.
    if (!isCold(board.sql, root)) {
      const pages = pagesOf(board).filter((meta) => meta.roots[0] <= root && root <= meta.roots[1])
      const unread = pages.filter((meta) => !state.pageCache.has(meta.id))
      if (pages.length > 0 && pages.length <= 2 && unread.length > 0 && !state.run?.read.has(root)) {
        for (const meta of unread) state.faults.pages.add(meta.id)
        return null
      }
    }
  }
  need(board, root)
  return null
}

/** The cold thread a message ID is in: null when none, undefined (faulted) while its segment isn't loaded. */
function rootOf(board: Board, id: number): number | null | undefined {
  const { sql } = board
  if (isCold(sql, id)) return id
  const frozen = pagesOf(board).length > 0
  if (!frozen && !sql.one("select 1 from cold_threads where state = 'cold' and root < ? and last_id >= ? limit 1", id, id)) return null
  // Which thread it's in is its message.posted's (its own position): hot, or in a segment.
  const event = eventAt(board, id)
  if (!event) return event
  if (event.type !== 'message.posted' || event.thread === null) return null
  if (isCold(sql, event.thread)) return event.thread
  // A posted message whose thread has no row is in a frozen thread.
  return frozen && !sql.one('select 1 from threads where root = ?', event.thread) ? event.thread : null
}

/** The event at a position: hot, or from a loaded segment; null when there's none, undefined (faulted) while its segment isn't loaded. */
function eventAt(board: Board, seq: number): Pick<EventRow, 'type' | 'thread'> | null | undefined {
  const hot = board.sql.one<Pick<EventRow, 'type' | 'thread'>>('select type, thread from events where seq = ?', seq)
  if (hot) return hot
  const segment = board.sql.one<{ first: number }>('select first from segments where first <= ? and last >= ?', seq, seq)
  if (!segment) return null
  const state = stateOf(board)
  const loaded = state.cache.get(segment.first)
  if (!loaded) return void state.faults.segments.add(segment.first)
  touch(state, loaded)
  return loaded.rows.get(seq) ?? null
}

function touch(state: State, segment: Segment) {
  state.cache.delete(segment.first)
  state.cache.set(segment.first, segment)
}

hooks.eventRows = (ctx, after, limit, upto = Number.MAX_SAFE_INTEGER) => {
  const board = (ctx as Ctx).board
  const hot = (from: number, count: number) => ctx.sql.all<EventRow>('select * from events where seq > ? and seq <= ? order by seq limit ?', from, upto, count)
  if (!board) return hot(after, limit)
  const top = sealedTop(board)
  if (after >= top) return hot(after, limit)
  const state = stateOf(board)
  const out: EventRow[] = []
  let counted = 0
  let missing = false
  const segments = ctx.sql.all<{ first: number; last: number }>('select first, last from segments where last > ? and first <= ? order by first', after, Math.min(upto, top))
  for (const segment of segments) {
    if (counted >= limit) break
    const from = Math.max(after + 1, segment.first)
    const to = Math.min(segment.last, upto)
    counted += to - from + 1
    const loaded = state.cache.get(segment.first)
    if (!loaded) {
      state.faults.segments.add(segment.first)
      missing = true
      continue
    }
    touch(state, loaded)
    for (let seq = from; seq <= to && out.length < limit; seq++) {
      const row = loaded.rows.get(seq)
      if (row) out.push(row)
    }
  }
  if (missing) return []
  if (out.length < limit && upto > top) out.push(...hot(Math.max(after, top), limit - out.length))
  return out
}

hooks.keyed = (ctx, key) => {
  if (!archivedAny(ctx.board)) return
  // A client ID's message is looked up in the tables, so its thread comes back.
  const { faults } = stateOf(ctx.board)
  const hash = hashKey(key)
  for (const row of ctx.sql.all<{ root: number }>("select k.root from cold_keys k join cold_threads c on c.root = k.root and c.state = 'cold' where k.hash = ?", hash)) faults.restore.add(row.root)
  // Frozen pages keep their keys in a Bloom filter each, hot: only a page that may hold it is read.
  for (const meta of pagesOf(ctx.board)) {
    if (!bloomHasHash(meta.keys, hash)) continue
    const page = pageOf(ctx.board, meta.id)
    if (!page) {
      faults.pages.add(meta.id)
      continue
    }
    for (const root of page.keys.get(hash) ?? []) if (frozenValid(ctx.sql, meta.at, root)) faults.restore.add(root)
  }
}

// -- filters over cold threads: from their facets, or (for text) from R2 ---------------------------------

/** What a message matches on, but its text and ID: one per kind of message a cold thread holds. */
type Sig = { a: string; p: string; f: string | null; l: Record<string, string>; m: string[]; r: 0 | 1; d: 0 | 1 }

const labelsOf = (row: { labels: string; deleted: number }): Record<string, string> => (row.deleted ? {} : (JSON.parse(row.labels || '{}') as Record<string, string>))
function withTask(sql: Sql, row: { id: number; re: number | null; deleted: number }, labels: Record<string, string>): Record<string, string> {
  if (row.re !== null || row.deleted) return labels
  const task = sql.one<{ state: string }>('select state from tasks where root = ?', row.id)
  return task ? { ...labels, 'board.task': task.state } : labels
}
/** A message's facet as Board.facet makes it, from rows read back. */
function facetOfRow(sql: Sql, row: MessageRow, root: MessageRow | undefined): Facet {
  const labels = withTask(sql, row, labelsOf(row))
  const rootLabels = row.re === null ? labels : root && !root.deleted ? withTask(sql, root, labelsOf(root)) : {}
  return { id: row.id, channel: row.channel, re: row.re, actor: row.actor, principal: row.principal, from: row.from_key, labels, rootLabels, text: row.deleted ? '' : row.text, terms: row.deleted ? [] : mentionTerms(row.text), deleted: Boolean(row.deleted) }
}
/** A facet from a cold thread's facets: exact for every filter but text and re naming a reply. */
function facetOfSig(sql: Sql, sig: Sig, root: MessageRow): Facet {
  const own = sig.d ? {} : sig.l
  const rootLabels = root.deleted ? {} : withTask(sql, root, labelsOf(root))
  const labels = sig.r ? own : sig.d ? {} : withTask(sql, root, own)
  return { id: sig.r ? -1 : root.id, channel: root.channel, re: sig.r ? root.id : null, actor: sig.a, principal: sig.p, from: sig.f, labels, rootLabels: sig.r ? rootLabels : labels, text: '', terms: sig.d ? [] : sig.m, deleted: Boolean(sig.d) }
}
/** A Sig as cold_facets keeps it: a tuple, with a principal that's its actor's and empty parts as 0. */
type PackedSig = [string, string | 0, string | null, Record<string, string> | 0, string[] | 0, 0 | 1, 0 | 1]
const packSig = (sig: Sig): PackedSig => [sig.a, sig.p === sig.a.split('+')[0] ? 0 : sig.p, sig.f, Object.keys(sig.l).length ? sig.l : 0, sig.m.length ? sig.m : 0, sig.r, sig.d]
const unpackSig = (packed: PackedSig | Sig): Sig => {
  if (!Array.isArray(packed)) return packed
  const [a, p, f, l, m, r, d] = packed
  return { a, p: p === 0 ? a.split('+')[0]! : p, f, l: l === 0 ? {} : l, m: m === 0 ? [] : m, r, d }
}
function sigsOf(rows: MessageRow[]): Sig[] {
  const out = new Map<string, Sig>()
  for (const row of rows) {
    const sig: Sig = { a: row.actor, p: row.principal, f: row.from_key, l: labelsOf(row), m: row.deleted ? [] : mentionTerms(row.text), r: row.re === null ? 0 : 1, d: row.deleted ? 1 : 0 }
    out.set(JSON.stringify(sig), sig)
  }
  return [...out.values()]
}

hooks.coldMatch = (ctx, root, compiled) => {
  if (!archivedAny(ctx.board)) return undefined
  let cold = ctx.sql.one<{ last_id: number; fingerprint: string | undefined; channel: string; facets: string | null }>("select c.last_id, c.fingerprint, c.channel, f.facets from cold_threads c left join cold_facets f on f.root = c.root where c.root = ? and c.state = 'cold'", root)
  let rootRow: MessageRow | null = null
  if (!cold) {
    // A frozen thread: what its page holds of it (the scan that found it read the page).
    const copy = frozenCopy(ctx.board, root)
    if (!copy) return undefined
    const own = copy.thread.rows.find(([id]) => id === root)
    rootRow = own ? unpackRow(ctx.sql, own[1]) : null
    cold = { last_id: copy.thread.lastId, fingerprint: undefined, channel: copy.thread.channel, facets: copy.thread.facets }
  }
  // Every message of a thread is in its channel: a channel filter decides without its facets.
  if (compiled.channel !== undefined) {
    const path = compiled.channel.endsWith('/') ? compiled.channel.slice(0, -1) : null
    if (path === null ? cold.channel !== compiled.channel : !(cold.channel === path || cold.channel.startsWith(path + '/'))) return false
  }
  rootRow ??= summaryRow(ctx.sql, root)
  const reReply = compiled.re !== undefined && compiled.re !== root && compiled.re > root && compiled.re <= cold.last_id
  if (compiled.text === undefined && !reReply && cold.facets !== null && rootRow) return (JSON.parse(cold.facets) as (PackedSig | Sig)[]).some((sig) => matches(compiled, facetOfSig(ctx.sql, unpackSig(sig), rootRow)))
  const entry = overlayOf(ctx.board, root, cold.fingerprint)
  if (entry) return entry.list.some((row) => matches(compiled, facetOfRow(ctx.sql, row, entry.rows.get(root))))
  need(ctx.board, root)
  return false
}

hooks.channelRows = (ctx, channel, after, limit, rows) => {
  const board = ctx.board
  if (!archivedAny(board)) return rows
  const included = new Set<number>()
  let merged = rows
  // The archived threads that could hold one of the page's messages, from the cold stubs and the
  // frozen pages' channel ranges: for the latest page, the limit with the newest last messages; after
  // a cursor, those with the first roots, again as the page narrows, until none is left. A frozen page
  // is read only while its range for the channel is still in reach.
  for (;;) {
    const bound = after === null ? (merged.length === limit ? merged[0]!.id : 0) : merged.length === limit ? merged[limit - 1]!.id : Number.MAX_SAFE_INTEGER
    const found = new Map<number, number>()
    const cold = after === null
      ? ctx.sql.all<{ root: number; last_id: number }>("select root, last_id from cold_threads where state = 'cold' and channel = ? and last_id > ? order by last_id desc limit ?", channel, bound, limit + included.size)
      : ctx.sql.all<{ root: number; last_id: number }>("select root, last_id from cold_threads where state = 'cold' and channel = ? and last_id > ? and root < ? and root not in (select value from json_each(?)) order by root limit ?", channel, after, bound, ctx.sql.list([...included]), limit + 50)
    for (const row of cold) if (!included.has(row.root)) found.set(row.root, row.last_id)
    const pages = pagesOf(board)
      .filter((meta) => {
        const range = meta.channels[channel]
        return range !== undefined && (after === null ? range[1] > bound : range[1] > after && range[0] < bound)
      })
      .sort((a, b) => (after === null ? b.channels[channel]![1] - a.channels[channel]![1] : a.channels[channel]![0] - b.channels[channel]![0]))
    let waiting: PageMeta[] | null = null
    for (const [i, meta] of pages.entries()) {
      const page = pageOf(board, meta.id)
      if (!page) {
        waiting = pages.slice(i)
        break
      }
      for (const thread of page.threads) {
        if (thread.channel !== channel || included.has(thread.root)) continue
        if (after === null ? thread.lastId <= bound : thread.lastId <= after || thread.root >= bound) continue
        if (frozenValid(ctx.sql, meta.at, thread.root)) found.set(thread.root, thread.lastId)
      }
    }
    const fresh = [...found.entries()]
      .sort((a, b) => (after === null ? b[1] - a[1] : a[0] - b[0]))
      .slice(0, after === null ? limit : limit + 50)
      .map(([root]) => root)
    if (fresh.length === 0) {
      if (waiting) {
        faultPages(board, waiting)
        return rows
      }
      return merged
    }
    let missing = false
    const messages: MessageRow[] = []
    for (const root of fresh) {
      included.add(root)
      const entry = overlayOf(board, root)
      if (entry) messages.push(...entry.list)
      else need(board, root), (missing = true)
    }
    if (missing) return rows
    const all = [...merged, ...messages].filter((row) => after === null || row.id > after).sort((a, b) => a.id - b.id)
    merged = after === null ? all.slice(-limit) : all.slice(0, limit)
  }
}

// A cold task thread keeps only its latest view hot; a view at an older position is in R2.
const hotTaskView = hooks.taskView
hooks.taskView = (ctx, root, at) => {
  const view = hotTaskView(ctx, root, at)
  if (view !== undefined || at === undefined || coldCount(ctx.board) === 0) return view
  // Its latest view is hot, so only an older one, of a task, can be in R2.
  if (!ctx.sql.one('select 1 from tasks where root = ?', root)) return undefined
  const cold = coldOf(ctx.sql, root)
  if (!cold) return undefined
  const entry = overlayOf(ctx.board, root, cold.fingerprint)
  if (!entry) {
    need(ctx.board, root)
    return undefined
  }
  const found = entry.views.filter(([seq]) => at === undefined || seq <= at).sort((a, b) => a[0] - b[0]).at(-1)
  return found ? JSON.parse(found[1]) : undefined
}

/** A client ID's index entry: 53 bits of two string hashes. A collision only loads a thread for nothing. */
export function hashKey(key: string): number {
  let h1 = 0x811c9dc5
  let h2 = 0x9747b28c
  for (let i = 0; i < key.length; i++) {
    const c = key.charCodeAt(i)
    h1 = Math.imul(h1 ^ c, 0x01000193)
    h2 = Math.imul(h2 ^ c, 0x5bd1e995)
    h2 ^= h2 >>> 13
  }
  return (h1 >>> 0) * 2097152 + (((h2 | 1) >>> 0) >>> 11)
}

// -- frozen pages: the summaries of long-cold threads, in R2, by latest activity ------------------------
//
// A thread cold past freezeAfterMs (and not a task) leaves SQLite altogether: its threads row, its
// stub, its summary rows and facets, and its client IDs go into an immutable page of pageThreads
// threads, written to boards/<board>/pages/<id>.json in the order /threads lists (latest activity,
// then root). What stays hot is the page's index row: its key range, a Bloom filter of its client
// IDs, and each channel's first root and last message in it. A scan reads a page (one GET) when it
// reaches the page's range, a few at once; a key lookup reads only the pages its filter lets
// through. A thread that comes back (a write, GET /messages/:id) gets a frozen_gone row, so the
// page's copy of it, older than that, is never read again.

type PageMeta = { id: number; min: [number, number]; max: [number, number]; roots: [number, number]; count: number; at: number; keys: Uint8Array; channels: Record<string, [number, number]> }
type FrozenThread = { root: number; channel: string; replies: number; last: number; fingerprint: string; lastId: number; count: number; active: number | null; rootDeleted: number; bytes: number; rows: [number, string][]; facets: string; keys: number[]; files: [string, number][] }
type Page = { meta: PageMeta; threads: FrozenThread[]; byRoot: Map<number, FrozenThread>; rows: Map<number, { root: number; row: string }>; keys: Map<number, number[]>; bytes: number }

const cmpKey = (a: [number, number], b: [number, number]) => a[0] - b[0] || a[1] - b[1]
const keyOfThread = (thread: { last: number; root: number }): [number, number] => [thread.last, thread.root]
export const pageKey = (board: string, id: number) => 'boards/' + board + '/pages/' + id + '.json'

/** The frozen pages' index, oldest first: read once an instance, kept as pages are frozen. */
function pagesOf(board: Board): PageMeta[] {
  const state = stateOf(board)
  state.pages ??= board.sql
    .all<{ id: number; min_last: number; min_root: number; max_last: number; max_root: number; first_root: number; last_root: number; count: number; at: number; keys: ArrayBuffer; channels: string }>('select id, min_last, min_root, max_last, max_root, first_root, last_root, count, at, keys, channels from frozen_pages order by id')
    .map((row) => ({ id: row.id, min: [row.min_last, row.min_root], max: [row.max_last, row.max_root], roots: [row.first_root, row.last_root], count: row.count, at: row.at, keys: new Uint8Array(row.keys), channels: JSON.parse(row.channels) }))
  return state.pages
}
function archivedAny(board: Board): boolean {
  return coldCount(board) > 0 || pagesOf(board).length > 0
}
/** A frozen page in memory, kept for this session. */
function pageOf(board: Board, id: number): Page | null {
  const state = stateOf(board)
  const page = state.pageCache.get(id)
  if (!page) return null
  state.pageCache.delete(id)
  state.pageCache.set(id, page)
  state.run?.pages.add(id)
  return page
}
/** Whether a page's copy of a thread is the thread as it is: it isn't back, and wasn't since the page. */
function frozenValid(sql: Sql, at: number, root: number): boolean {
  if (sql.one('select 1 from threads where root = ?', root)) return false
  const gone = sql.one<{ at: number }>('select at from frozen_gone where root = ?', root)
  return !gone || gone.at < at
}
/** A frozen thread's current copy, from a page in memory. */
function frozenCopy(board: Board, root: number): { page: Page; thread: FrozenThread } | null {
  for (const page of stateOf(board).pageCache.values()) {
    const thread = page.byRoot.get(root)
    if (thread && frozenValid(board.sql, page.meta.at, root)) {
      stateOf(board).run?.pages.add(page.meta.id)
      return { page, thread }
    }
  }
  return null
}
/** A frozen thread's root or last message, from a page in memory. */
function frozenRow(board: Board, id: number): MessageRow | null {
  for (const page of stateOf(board).pageCache.values()) {
    const found = page.rows.get(id)
    if (found && frozenValid(board.sql, page.meta.at, found.root)) {
      stateOf(board).run?.pages.add(page.meta.id)
      return unpackRow(board.sql, found.row)
    }
  }
  return null
}
/** Asks for the pages a run reaches, in the order it reaches them: 2, then 4, 8, ... at once, each round of a call. */
function faultPages(board: Board, metas: PageMeta[]) {
  const state = stateOf(board)
  const width = Math.min(PAGES_AT_ONCE, 2 ** ((state.run?.pageRounds ?? 0) + 1))
  let asked = 0
  for (const meta of metas) {
    if (asked >= width) break
    if (state.pageCache.has(meta.id)) continue
    state.faults.pages.add(meta.id)
    asked++
  }
}

/**
 * A Bloom filter of client ID hashes (hashKey): 32 bits and 22 probes each. A key that isn't there
 * passes a page's filter about once in a million (measured), so a key lookup across 20,000 pages
 * reads a page it didn't need about once in 50. Every keyed post asks, so the filters are tight.
 */
const KEY_BITS = 32
const KEY_PROBES = 22
function bloomOfHashes(hashes: number[]): Uint8Array {
  const bits = new Uint8Array(Math.max(8, Math.ceil((hashes.length * KEY_BITS) / 8)))
  const size = bits.length * 8
  for (const hash of hashes) {
    const seed = seedOf(hash)
    for (let i = 0; i < KEY_PROBES; i++) {
      const bit = mix32(seed + Math.imul(i, 0x9e3779b9)) % size
      bits[bit >>> 3]! |= 1 << (bit & 7)
    }
  }
  return bits
}
function bloomHasHash(bits: Uint8Array, hash: number): boolean {
  const size = bits.length * 8
  const seed = seedOf(hash)
  for (let i = 0; i < KEY_PROBES; i++) {
    const bit = mix32(seed + Math.imul(i, 0x9e3779b9)) % size
    if (!(bits[bit >>> 3]! & (1 << (bit & 7)))) return false
  }
  return true
}
// Each probe its own mix of the key: double hashing (a + i*b) shares factors with the filter's size.
const mix32 = (value: number) => {
  let x = Math.imul(value ^ (value >>> 16), 0x85ebca6b)
  x = Math.imul(x ^ (x >>> 13), 0xc2b2ae35)
  return (x ^ (x >>> 16)) >>> 0
}
const seedOf = (hash: number) => mix32((hash % 4294967296 >>> 0) ^ Math.imul(Math.floor(hash / 4294967296) >>> 0, 0x9e3779b1))

// The threads /threads lists: the hot table (threads), and the frozen pages, merged in its order.
const hotScan = hooks.threadScan
hooks.threadScan = (ctx, after, before) => {
  const board = (ctx as Ctx).board
  const hot = hotScan(ctx, after, before)
  if (!board || pagesOf(board).length === 0) return hot
  const ascending = after !== null
  const start: [number, number] | null = before ? [before.at, before.id] : null
  const inRange = (key: [number, number]) => (ascending ? key[0] > after! : start === null || cmpKey(key, start) < 0)
  const better = (a: ThreadRow, b: ThreadRow) => (ascending ? cmpKey(keyOfThread(a), keyOfThread(b)) < 0 : cmpKey(keyOfThread(a), keyOfThread(b)) > 0)
  const pages = pagesOf(board)
    .filter((meta) => (ascending ? meta.max[0] > after! : start === null || cmpKey(meta.min, start) < 0))
    .sort((a, b) => (ascending ? cmpKey(a.min, b.min) : cmpKey(b.max, a.max)))
  const open: { rows: ThreadRow[]; at: number }[] = []
  let next = 0
  let buffer: ThreadRow[] = []
  let hotDone = false
  return (batch) => {
    const out: ThreadRow[] = []
    while (out.length < batch) {
      if (buffer.length === 0 && !hotDone) {
        buffer = hot(batch)
        if (buffer.length < batch) hotDone = true
      }
      let best: ThreadRow | undefined = buffer[0]
      let from = -1
      for (const [i, stream] of open.entries()) {
        const head = stream.rows[stream.at]
        if (head && (!best || better(head, best))) (best = head), (from = i)
      }
      // A page not opened yet may hold a thread that comes before it.
      const page = pages[next]
      if (page && (!best || (ascending ? cmpKey(page.min, keyOfThread(best)) < 0 : cmpKey(page.max, keyOfThread(best)) > 0))) {
        const loaded = pageOf(board, page.id)
        if (!loaded) {
          faultPages(board, pages.slice(next))
          return []
        }
        const rows = loaded.threads
          .filter((thread) => inRange(keyOfThread(thread)) && frozenValid(ctx.sql, page.at, thread.root))
          .map((thread): ThreadRow => ({ root: thread.root, last: thread.last, replies: thread.replies, channel: thread.channel }))
        open.push({ rows: ascending ? rows : rows.reverse(), at: 0 })
        next++
        continue
      }
      if (!best) break
      if (from < 0) buffer.shift()
      else open[from]!.at++
      out.push(best)
    }
    return out
  }
}

async function loadPage(rt: Runtime, bucket: R2Bucket, session: Session, id: number) {
  const state = stateOf(rt.board)
  session.pages.add(id)
  if (state.pageCache.has(id)) return
  const meta = pagesOf(rt.board).find((entry) => entry.id === id)
  if (!meta) return
  const key = pageKey(rt.mount.name, id)
  const object = await bucket.get(key)
  if (!object) throw missingArchive(key)
  const text = await object.text()
  const threads = (JSON.parse(text) as { threads: FrozenThread[] }).threads
  const page: Page = { meta, threads, byRoot: new Map(), rows: new Map(), keys: new Map(), bytes: text.length * 2 }
  for (const thread of threads) {
    page.byRoot.set(thread.root, thread)
    for (const [message, row] of thread.rows) page.rows.set(message, { root: thread.root, row })
    for (const hash of thread.keys) page.keys.set(hash, [...(page.keys.get(hash) ?? []), thread.root])
  }
  state.pageCache.set(id, page)
  state.pageBytes += page.bytes
  evictPages(state)
}

/** Oldest use first, past the budget, but never one an open session read. */
function evictPages(state: State) {
  if (state.pageBytes <= PAGE_BYTES) return
  const held = new Set<number>()
  for (const session of state.sessions) for (const id of session.pages) held.add(id)
  for (const [id, page] of state.pageCache) {
    if (state.pageBytes <= PAGE_BYTES) break
    if (held.has(id)) continue
    state.pageCache.delete(id)
    state.pageBytes -= page.bytes
  }
}

// -- loading what a run faulted on ---------------------------------------------------------------------

const bucketOf = (rt: Pick<Runtime, 'env'>): R2Bucket | null => (rt.env.FILES as R2Bucket | undefined) ?? null
export const segmentKey = (board: string, first: number, last: number) => 'boards/' + board + '/segments/' + first + '-' + last
export const threadKey = (board: string, root: number) => 'boards/' + board + '/threads/' + root + '.json'
const missingArchive = (key: string) => new WorkbusError(500, 'archive_missing', 'the archive has no ' + key)

/** Loads what the last run faulted on, all of it at once: segments and threads read, threads put back. */
export async function loadFaults(rt: Runtime, session: Session): Promise<void> {
  const state = stateOf(rt.board)
  const restore = [...state.faults.restore]
  const read = [...state.faults.read].filter((root) => !state.faults.restore.has(root))
  const segments = [...state.faults.segments]
  const pages = [...state.faults.pages]
  state.faults.restore.clear()
  state.faults.read.clear()
  state.faults.segments.clear()
  state.faults.pages.clear()
  state.run = null
  if (restore.length + read.length + segments.length + pages.length === 0) return
  state.loads.rounds++
  state.loads.restored += restore.length
  state.loads.read += read.length
  state.loads.segments += segments.length
  state.loads.pages += pages.length
  if (pages.length) session.pageRounds++
  const bucket = bucketOf(rt)
  if (!bucket) throw new WorkbusError(500, 'archive_missing', 'this board has archived history and no FILES bucket to read it from')
  const round = new Set(segments)
  await inBatches([
    ...segments.map((first) => () => loadSegment(rt, bucket, first, round)),
    ...pages.map((id) => () => loadPage(rt, bucket, session, id)),
    ...restore.map((root) => () => restoreThread(rt, bucket, session, root)),
    ...read.map((root) => () => readThread(rt, bucket, session, root)),
  ], WIDTH)
}

async function inBatches(tasks: (() => Promise<unknown>)[], width: number) {
  let next = 0
  await Promise.all(Array.from({ length: Math.min(width, tasks.length) }, async () => {
    while (next < tasks.length) await tasks[next++]!()
  }))
}

async function loadSegment(rt: Runtime, bucket: R2Bucket, first: number, round: Set<number>) {
  const state = stateOf(rt.board)
  if (state.cache.has(first)) return
  const segment = rt.sql.one<{ first: number; last: number; key: string; sha256: string }>('select first, last, key, sha256 from segments where first = ?', first)
  if (!segment) return
  const object = await bucket.get(segment.key)
  if (!object) throw missingArchive(segment.key)
  const text = await new Response(object.body.pipeThrough(new DecompressionStream('gzip'))).text()
  const rows = new Map<number, EventRow>()
  for (const line of text.split('\n')) if (line) {
    const row = JSON.parse(line) as EventRow
    rows.set(row.seq, row)
  }
  if (rows.size !== segment.last - segment.first + 1) throw new WorkbusError(500, 'archive_corrupt', segment.key + ' holds ' + rows.size + ' events, not ' + (segment.last - segment.first + 1))
  const loaded: Segment = { first: segment.first, last: segment.last, rows, bytes: text.length * 2 }
  state.cache.set(first, loaded)
  state.cacheBytes += loaded.bytes
  // Oldest use first, but never one this round loaded: the run it's for reads them all.
  for (const [key, entry] of state.cache) {
    if (state.cacheBytes <= CACHE_BYTES) break
    if (round.has(key)) continue
    state.cache.delete(key)
    state.cacheBytes -= entry.bytes
  }
}

type ThreadObject = { v: 1; root: number; fingerprint: string; messages: Record<string, unknown>[]; terms: [string, number][]; taskViews: [number, string][] }
const COLUMN = /^[a-z_]+$/

async function fetchThread(rt: Runtime, bucket: R2Bucket, root: number): Promise<{ data: ThreadObject; bytes: number }> {
  const key = threadKey(rt.mount.name, root)
  const object = await bucket.get(key)
  if (!object) throw missingArchive(key)
  const text = await object.text()
  return { data: JSON.parse(text) as ThreadObject, bytes: text.length * 2 }
}

/** A cold thread into memory, for the reads of this session. */
async function readThread(rt: Runtime, bucket: R2Bucket, session: Session, root: number) {
  const state = stateOf(rt.board)
  const cold = coldOf(rt.sql, root)
  // Neither cold nor frozen: it's back in its tables.
  if (!cold && rt.sql.one('select 1 from threads where root = ?', root)) return
  // Kept for this session, whose next run reads it.
  session.read.add(root)
  const known = state.overlay.get(root)
  if (known && (cold ? known.fingerprint === cold.fingerprint : frozenValid(rt.sql, known.at - 1, root))) return
  const { data, bytes } = await fetchThread(rt, bucket, root)
  session.bytes += bytes
  if (session.bytes > SESSION_BYTES) throw archiveBusy()
  const list = data.messages as unknown as MessageRow[]
  const entry: Overlay = { root, fingerprint: data.fingerprint, rows: new Map(list.map((row) => [row.id, row])), list, views: data.taskViews, bytes, at: Date.now() }
  const old = state.overlay.get(root)
  if (old) state.overlayBytes -= old.bytes
  state.overlay.delete(root)
  state.overlay.set(root, entry)
  state.overlayBytes += bytes
  evictOverlay(state)
}

/** Oldest use first, past the budget, but never one an open session read. */
function evictOverlay(state: State) {
  if (state.overlayBytes <= OVERLAY_BYTES) return
  const held = new Set<number>()
  for (const session of state.sessions) for (const root of session.read) held.add(root)
  for (const [root, entry] of state.overlay) {
    if (state.overlayBytes <= OVERLAY_BYTES) break
    if (held.has(root)) continue
    state.overlay.delete(root)
    state.overlayBytes -= entry.bytes
  }
}

/** A cold thread back in its tables, kept from going cold again until this session ends. */
async function restoreThread(rt: Runtime, bucket: R2Bucket, session: Session, root: number) {
  const state = stateOf(rt.board)
  if (!session.restored.has(root)) {
    session.restored.add(root)
    state.pinned.set(root, (state.pinned.get(root) ?? 0) + 1)
  }
  const frozen = () => !isCold(rt.sql, root) && !rt.sql.one('select 1 from threads where root = ?', root)
  if (!isCold(rt.sql, root) && !frozen()) return
  const { data } = await fetchThread(rt, bucket, root)
  rt.sql.transaction(() => {
    if (frozen()) return unfreeze(rt, root, data)
    // Another request may have put it back while this one waited.
    if (!isCold(rt.sql, root)) return
    for (const message of data.messages) {
      const columns = Object.keys(message).filter((column) => COLUMN.test(column))
      rt.sql.run('insert into messages (' + columns.join(', ') + ') values (' + columns.map(() => '?').join(', ') + ')', ...columns.map((column) => message[column]))
    }
    for (const [term, message] of data.terms) rt.sql.run('insert or ignore into terms (term, message, root) values (?, ?, ?)', term, message, root)
    for (const [seq, view] of data.taskViews) rt.sql.run('insert or ignore into task_views (root, seq, view) values (?, ?, ?)', root, seq, view)
    rt.sql.run("update cold_threads set state = 'warm', warmed = ? where root = ?", Date.now(), root)
    rt.sql.run('delete from cold_rows where root = ?', root)
    rt.sql.run('delete from cold_facets where root = ?', root)
    rt.sql.run('update threads set archived = null where root = ?', root)
  })
  state.cold = null
}

/** A frozen thread back in its tables, with its threads row and a stub that says its R2 copy is current. */
function unfreeze(rt: Runtime, root: number, data: ThreadObject) {
  const messages = data.messages as unknown as MessageRow[]
  for (const message of data.messages) {
    const columns = Object.keys(message).filter((column) => COLUMN.test(column))
    rt.sql.run('insert into messages (' + columns.join(', ') + ') values (' + columns.map(() => '?').join(', ') + ')', ...columns.map((column) => message[column]))
  }
  for (const [term, message] of data.terms) rt.sql.run('insert or ignore into terms (term, message, root) values (?, ?, ?)', term, message, root)
  for (const [seq, view] of data.taskViews) rt.sql.run('insert or ignore into task_views (root, seq, view) values (?, ?, ?)', root, seq, view)
  for (const file of rt.sql.all<{ term: string; message: number }>('select term, message from frozen_files where root = ?', root)) rt.sql.run('insert or ignore into terms (term, message, root) values (?, ?, ?)', file.term, file.message, root)
  rt.sql.run('delete from frozen_files where root = ?', root)
  const rootRow = messages.find((row) => row.id === root)!
  // As refreshThread keeps it: its latest live reply (or its root), and how many live replies.
  const live = messages.filter((row) => row.re !== null && !row.deleted)
  const last = live.length ? Math.max(...live.map((row) => row.id)) : root
  rt.sql.run('insert into threads (root, channel, replies, last, archived) values (?, ?, ?, ?, null)', root, rootRow.channel, live.length, last, )
  const active = messages.find((row) => row.id === last)?.created_at ?? rootRow.created_at
  rt.sql.run(
    "insert into cold_threads (root, channel, state, fingerprint, last_id, count, active, root_deleted, digest, bytes, at, warmed) values (?, ?, 'warm', ?, ?, ?, ?, ?, ?, 0, ?, ?) on conflict (root) do update set state = 'warm', fingerprint = excluded.fingerprint, warmed = excluded.warmed",
    root, rootRow.channel, data.fingerprint, Math.max(...messages.map((row) => row.id)), messages.length, active, rootRow.deleted, new ArrayBuffer(0), Date.now(), Date.now(),
  )
  // Every page's copy of it is older than this.
  rt.sql.run('insert into frozen_gone (root, at) values (?, ?) on conflict (root) do update set at = excluded.at', root, Date.now())
}

/** Before an op: the board's miss hook, and its archival timer, once an instance. */
export function prepare(rt: Runtime) {
  const state = stateOf(rt.board)
  if (state.armed) return
  state.armed = true
  const config = configOf(rt.sql, rt.env)
  if (!config.enabled || !bucketOf(rt)) return
  rt.sql.run('insert into timers (kind, ref, due) values (?, ?, ?) on conflict (kind, ref) do nothing', 'archive', 'board', Date.now() + config.everyMs)
}

// -- the work: sealing and cooling, in bounded steps ------------------------------------------------------------

/** The position nothing above may leave the hot set: what watchers and registrations have yet to take. */
function floorOf(rt: Runtime): number {
  let floor = rt.board.head
  const outbox = rt.sql.one<{ seq: number | null }>('select min(seq) as seq from outbox')?.seq
  if (outbox !== null && outbox !== undefined) floor = Math.min(floor, outbox)
  const pending = rt.sql.one<{ seq: number | null }>("select min(seq) as seq from matches where state = 'pending'")?.seq
  if (pending !== null && pending !== undefined) floor = Math.min(floor, pending - 1)
  try {
    for (const [key, value] of rt.storage.kv.list<number>({ prefix: 'watchStart:' })) {
      if (!rt.sql.one('select 1 from outbox where destination = ?', 'watch:' + key.slice('watchStart:'.length))) floor = Math.min(floor, Number(value))
    }
  } catch {}
  return floor
}

/** The last position at or before a time: segments by their last event, then a search of the hot log. */
function seqAtOrBefore(rt: Runtime, time: number): number {
  const top = sealedTop(rt.board)
  const sealed = rt.sql.one<{ last: number | null }>('select max(last) as last from segments where at <= ?', time)?.last ?? 0
  let lo = top + 1
  let hi = rt.board.head
  const at = (seq: number) => rt.sql.one<{ at: number }>('select at from events where seq = ?', seq)?.at ?? Number.MAX_SAFE_INTEGER
  if (lo > hi || at(lo) > time) return sealed
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2)
    if (at(mid) <= time) lo = mid
    else hi = mid - 1
  }
  return lo
}

async function gzip(text: string): Promise<Uint8Array> {
  const stream = new Blob([text]).stream().pipeThrough(new CompressionStream('gzip'))
  return new Uint8Array(await new Response(stream).arrayBuffer())
}
const hex = (buffer: ArrayBuffer) => [...new Uint8Array(buffer)].map((byte) => byte.toString(16).padStart(2, '0')).join('')
const sha256 = async (text: string) => hex(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text)))

/** Seals the next range of the log, when all of it is old enough and taken by everyone: true when it did. */
async function sealNext(rt: Runtime, config: ArchiveConfig, bucket: R2Bucket): Promise<boolean> {
  const first = sealedTop(rt.board) + 1
  const last = first + config.segment - 1
  const limit = Math.min(rt.board.head - config.keep, seqAtOrBefore(rt, Date.now() - config.sealAfterMs), floorOf(rt))
  if (last > limit) return false
  const rows = rt.sql.all<EventRow>('select * from events where seq between ? and ? order by seq', first, last)
  if (rows.length !== config.segment) throw new WorkbusError(500, 'archive_gap', 'events ' + first + '..' + last + ' have ' + rows.length + ' rows')
  const text = rows.map((row) => JSON.stringify(row)).join('\n') + '\n'
  const digest = await sha256(text)
  const key = segmentKey(rt.mount.name, first, last)
  const body = await gzip(text)
  // Written once: a step that wrote it and stopped before recording it left the same bytes.
  let stored: R2Object | null = await bucket.put(key, body, { onlyIf: { etagDoesNotMatch: '*' }, httpMetadata: { contentType: 'application/gzip' }, customMetadata: { sha256: digest, first: String(first), last: String(last) } })
  if (!stored) {
    stored = await bucket.head(key)
    if (stored?.customMetadata?.sha256 !== digest) throw new WorkbusError(500, 'archive_conflict', key + ' is in R2 with other events')
  }
  const size = stored.size
  rt.sql.transaction(() => {
    if ((rt.sql.one<{ last: number | null }>('select max(last) as last from segments')?.last ?? 0) !== first - 1) return
    rt.sql.run('insert into segments (first, last, key, bytes, sha256, at) values (?, ?, ?, ?, ?, ?)', first, last, key, size, digest, rows.at(-1)!.at)
    rt.sql.run('delete from events where seq between ? and ?', first, last)
  })
  stateOf(rt.board).sealed = null
  return true
}

type Candidate = { root: number; fingerprint: string }

/** A thread that may go cold now, with what it holds; null when it may not. */
function eligible(rt: Runtime, root: number, cutoff: number, coldAfterMs: number): Candidate | null {
  const stats = rt.sql.one<{ n: number; v: number | null; last_id: number | null; imported: number | null }>(
    'select count(*) as n, max(version) as v, max(id) as last_id, sum(from_key is not null or imported_by is not null) as imported from messages where thread = ?', root,
  )
  if (!stats || stats.n === 0 || stats.v === null || stats.last_id === null) return null
  // A call that put it back is still using it.
  if (stateOf(rt.board).pinned.has(root)) return null
  if (stats.v > cutoff || stats.last_id > cutoff || stats.imported) return null
  if (rt.sql.one("select 1 from tasks where root = ? and state in ('waiting', 'ready', 'claimed', 'blocked')", root)) return null
  if (rt.sql.one("select 1 from schedules where state = 'pending' and re in (select id from messages where thread = ?) limit 1", root)) return null
  if (rt.sql.one('select 1 from sync_threads where thread = ? limit 1', root)) return null
  if (rt.sql.one('select 1 from sync_copies where message in (select id from messages where thread = ?) limit 1', root)) return null
  if (rt.sql.one("select 1 from matches where thread = ? and state = 'pending' limit 1", root)) return null
  const warmed = rt.sql.one<{ warmed: number | null }>('select warmed from cold_threads where root = ?', root)?.warmed
  if (warmed !== null && warmed !== undefined && warmed > Date.now() - coldAfterMs) return null
  return { root, fingerprint: stats.n + ':' + stats.v + ':' + stats.last_id }
}

type Snapshot = Candidate & { body: string | null; keys: string[]; authors: [string, string][]; channel: string; lastId: number; count: number; active: number; rootDeleted: number; summary: [number, string][]; facets: string; bytes: number }

function snapshot(rt: Runtime, candidate: Candidate): Snapshot {
  const { root } = candidate
  const messages = rt.sql.all<MessageRow & Record<string, unknown>>('select * from messages where thread = ? order by id', root)
  const terms = rt.sql.all<{ term: string; message: number }>("select term, message from terms where root = ? and substr(term, 1, 1) != '^' and substr(term, 1, 2) != 'k:'", root).map((row): [string, number] => [row.term, row.message])
  const taskViews = rt.sql.all<{ seq: number; view: string }>('select seq, view from task_views where root = ?', root).map((row): [number, string] => [row.seq, row.view])
  const rootRow = messages.find((row) => row.id === root)!
  const thread = rt.sql.one<{ last: number }>('select last from threads where root = ?', root)
  const last = messages.find((row) => row.id === thread?.last) ?? rootRow
  const keys = new Set<string>()
  for (const row of messages) if (row.client_key) keys.add(row.client_key)
  keys.add(rootRow.thread_key)
  const authors = new Map<string, [string, string]>()
  for (const row of messages) authors.set(row.channel + '\u0000' + row.actor, [row.channel, row.actor])
  const cold = rt.sql.one<{ fingerprint: string; bytes: number }>('select fingerprint, bytes from cold_threads where root = ?', root)
  // Read back and unchanged since: its R2 copy is still what it holds.
  const body = cold?.fingerprint === candidate.fingerprint ? null : JSON.stringify({ v: 1, root, fingerprint: candidate.fingerprint, messages, terms, taskViews } satisfies ThreadObject)
  return {
    ...candidate, body, keys: [...keys], authors: [...authors.values()], channel: rootRow.channel, lastId: messages.at(-1)!.id, count: messages.length,
    active: last.created_at, rootDeleted: rootRow.deleted, bytes: body === null ? cold!.bytes : 0,
    // What a listing shows of it (its root and its last message) and what a filter matches on.
    summary: [...new Map([rootRow, last].map((row): [number, string] => [row.id, packRow(rt.sql, row)]))], facets: JSON.stringify(sigsOf(messages).map(packSig)),
  }
}

/** Moves a batch of idle threads to R2: true when there may be more. */
async function coolSome(rt: Runtime, config: ArchiveConfig, bucket: R2Bucket): Promise<{ cooled: number; more: boolean }> {
  const cutoff = Math.min(seqAtOrBefore(rt, Date.now() - config.coldAfterMs), floorOf(rt))
  const scan = JSON.parse(rt.sql.one<{ value: string }>("select value from meta where key = 'archive_scan'")?.value ?? '{"last":0,"root":0}') as { last: number; root: number }
  const rows = rt.sql.all<{ root: number; last: number }>(
    'select root, last from threads where archived is null and last <= ? and (last > ? or (last = ? and root > ?)) order by last, root limit ?',
    cutoff, scan.last, scan.last, scan.root, config.stepThreads * 4,
  )
  const picked: Candidate[] = []
  let examined: { root: number; last: number } | null = null
  for (const row of rows) {
    examined = row
    const candidate = eligible(rt, row.root, cutoff, config.coldAfterMs)
    if (candidate) picked.push(candidate)
    if (picked.length >= config.stepThreads) break
  }
  const done = rows.length === 0 || (rows.length < config.stepThreads * 4 && examined === rows.at(-1))
  const snapshots = picked.map((candidate) => snapshot(rt, candidate))
  await inBatches(snapshots.map((snap) => async () => {
    if (snap.body === null) return
    const stored = await bucket.put(threadKey(rt.mount.name, snap.root), snap.body, { httpMetadata: { contentType: 'application/json' }, customMetadata: { fingerprint: snap.fingerprint } })
    snap.bytes = stored.size
  }), WIDTH)
  let cooled = 0
  rt.sql.transaction(() => {
    for (const snap of snapshots) {
      // Changed while its bytes were on their way: it stays hot, and the next pass looks again.
      if (eligible(rt, snap.root, cutoff, config.coldAfterMs)?.fingerprint !== snap.fingerprint) continue
      rt.sql.run('delete from messages where thread = ?', snap.root)
      rt.sql.run("delete from terms where root = ? and substr(term, 1, 1) != '^' and substr(term, 1, 2) != 'k:'", snap.root)
      rt.sql.run('delete from task_views where root = ?1 and seq < (select max(seq) from task_views where root = ?1)', snap.root)
      rt.sql.run(
        "insert into cold_threads (root, channel, state, fingerprint, last_id, count, active, root_deleted, digest, bytes, at, warmed) values (?, ?, 'cold', ?, ?, ?, ?, ?, ?, ?, ?, null) on conflict (root) do update set channel = excluded.channel, state = 'cold', fingerprint = excluded.fingerprint, last_id = excluded.last_id, count = excluded.count, active = excluded.active, root_deleted = excluded.root_deleted, digest = excluded.digest, bytes = excluded.bytes, at = excluded.at, warmed = null",
        snap.root, snap.channel, snap.fingerprint, snap.lastId, snap.count, snap.active, snap.rootDeleted, new ArrayBuffer(0), snap.bytes, Date.now(),
      )
      rt.sql.run('delete from cold_rows where root = ?', snap.root)
      for (const [id, row] of snap.summary) rt.sql.run('insert into cold_rows (id, root, row) values (?, ?, ?)', id, snap.root, row)
      rt.sql.run('insert into cold_facets (root, facets) values (?, ?) on conflict (root) do update set facets = excluded.facets', snap.root, snap.facets)
      for (const key of snap.keys) rt.sql.run('insert or ignore into cold_keys (hash, root) values (?, ?)', hashKey(key), snap.root)
      for (const [channel, actor] of snap.authors) rt.sql.run('insert or ignore into cold_authors (channel, actor) values (?, ?)', channel, actor)
      rt.sql.run('update threads set archived = ? where root = ?', threadKey(rt.mount.name, snap.root), snap.root)
      cooled++
    }
    if (done) rt.sql.run("delete from meta where key = 'archive_scan'")
    else if (examined) rt.sql.run("insert into meta (key, value) values ('archive_scan', ?) on conflict (key) do update set value = excluded.value", JSON.stringify({ last: examined.last, root: examined.root }))
  })
  stateOf(rt.board).cold = null
  return { cooled, more: !done || cooled > 0 }
}

/** Freezes the summaries of threads cold past freezeAfterMs into full pages: true when it froze any. */
async function freezeSome(rt: Runtime, config: ArchiveConfig, bucket: R2Bucket): Promise<boolean> {
  const state = stateOf(rt.board)
  const rows = rt.sql.all<{ root: number }>(
    "select c.root from cold_threads c join threads t on t.root = c.root where c.state = 'cold' and c.at <= ? and not exists (select 1 from tasks k where k.root = c.root) and not exists (select 1 from docs d where d.root = c.root) order by t.last, t.root limit ?",
    Date.now() - config.freezeAfterMs, config.pageThreads * 4,
  ).filter((row) => !state.pinned.has(row.root))
  const count = Math.floor(rows.length / config.pageThreads)
  if (count === 0) return false
  const first = (rt.sql.one<{ id: number | null }>('select max(id) as id from frozen_pages')?.id ?? 0) + 1
  const pages = Array.from({ length: count }, (_, i) => {
    const threads = rows.slice(i * config.pageThreads, (i + 1) * config.pageThreads).map(({ root }) => frozenOf(rt, root))
    return { id: first + i, threads }
  })
  const sizes = new Map<number, number>()
  await inBatches(pages.map((page) => async () => {
    const stored = await bucket.put(pageKey(rt.mount.name, page.id), JSON.stringify({ v: 1, id: page.id, threads: page.threads }), { httpMetadata: { contentType: 'application/json' } })
    sizes.set(page.id, stored.size)
  }), WIDTH)
  rt.sql.transaction(() => {
    for (const page of pages) {
      const at = Date.now()
      const keys: number[] = []
      const channels: Record<string, [number, number]> = {}
      for (const thread of page.threads) {
        keys.push(...thread.keys)
        const range = channels[thread.channel]
        channels[thread.channel] = range ? [Math.min(range[0], thread.root), Math.max(range[1], thread.lastId)] : [thread.root, thread.lastId]
        // Changed while the page was on its way: it stays where it is, and the page's copy of it is never read.
        const now = rt.sql.one<{ fingerprint: string }>("select fingerprint from cold_threads where root = ? and state = 'cold'", thread.root)
        if (now?.fingerprint !== thread.fingerprint || state.pinned.has(thread.root)) {
          rt.sql.run('insert into frozen_gone (root, at) values (?, ?) on conflict (root) do update set at = excluded.at', thread.root, at + 1)
          continue
        }
        rt.sql.run('delete from threads where root = ?', thread.root)
        rt.sql.run('delete from cold_threads where root = ?', thread.root)
        rt.sql.run('delete from cold_rows where root = ?', thread.root)
        rt.sql.run('delete from cold_facets where root = ?', thread.root)
        rt.sql.run('delete from cold_keys where root = ?', thread.root)
        for (const [term, message] of thread.files) rt.sql.run('insert or ignore into frozen_files (term, message, root, channel) values (?, ?, ?, ?)', term, message, thread.root, thread.channel)
        rt.sql.run("delete from terms where root = ? and (substr(term, 1, 1) = '^' or substr(term, 1, 2) = 'k:')", thread.root)
      }
      const min = keyOfThread(page.threads[0]!)
      const max = keyOfThread(page.threads.at(-1)!)
      const bloom = bloomOfHashes(keys)
      rt.sql.run(
        'insert into frozen_pages (id, min_last, min_root, max_last, max_root, first_root, last_root, count, messages, key, bytes, at, keys, channels) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
        page.id, min[0], min[1], max[0], max[1], Math.min(...page.threads.map((thread) => thread.root)), Math.max(...page.threads.map((thread) => thread.root)), page.threads.length, page.threads.reduce((sum, thread) => sum + thread.count, 0), pageKey(rt.mount.name, page.id), sizes.get(page.id) ?? 0, at, bloom.buffer.slice(bloom.byteOffset, bloom.byteOffset + bloom.byteLength), JSON.stringify(channels),
      )
    }
  })
  state.pages = null
  state.cold = null
  return true
}

/** What a page keeps of a cold thread: everything a listing, a filter, or a key lookup reads of it. */
function frozenOf(rt: Runtime, root: number): FrozenThread {
  const thread = rt.sql.one<{ channel: string; replies: number; last: number }>('select channel, replies, last from threads where root = ?', root)!
  const cold = rt.sql.one<{ fingerprint: string; last_id: number; count: number; active: number | null; root_deleted: number; bytes: number }>('select fingerprint, last_id, count, active, root_deleted, bytes from cold_threads where root = ?', root)!
  return {
    root, channel: thread.channel, replies: thread.replies, last: thread.last, fingerprint: cold.fingerprint, lastId: cold.last_id, count: cold.count, active: cold.active, rootDeleted: cold.root_deleted, bytes: cold.bytes,
    rows: rt.sql.all<{ id: number; row: string }>('select id, row from cold_rows where root = ?', root).map((row): [number, string] => [row.id, row.row]),
    facets: rt.sql.one<{ facets: string }>('select facets from cold_facets where root = ?', root)?.facets ?? '[]',
    keys: rt.sql.all<{ hash: number }>('select hash from cold_keys where root = ?', root).map((row) => row.hash),
    files: rt.sql.all<{ term: string; message: number }>("select term, message from terms where root = ? and (substr(term, 1, 1) = '^' or substr(term, 1, 2) = 'k:')", root).map((row): [string, number] => [row.term, row.message]),
  }
}

/** One step: a segment sealed, then a batch of threads cooled. True when there's more to do. */
export async function archiveStep(rt: Runtime): Promise<{ sealed: boolean; cooled: number; frozen: boolean; more: boolean }> {
  const config = configOf(rt.sql, rt.env)
  const bucket = bucketOf(rt)
  if (!config.enabled || !bucket) return { sealed: false, cooled: 0, frozen: false, more: false }
  const sealed = await sealNext(rt, config, bucket)
  const { cooled, more } = await coolSome(rt, config, bucket)
  const frozen = await freezeSome(rt, config, bucket)
  return { sealed, cooled, frozen, more: sealed || more || frozen }
}

ASYNC_TIMERS.archive = async (rt) => {
  const config = configOf(rt.sql, rt.env)
  if (!config.enabled) return
  const result = await archiveStep(rt)
  const last = { at: Date.now(), ...result }
  rt.sql.run("insert into meta (key, value) values ('archive_last', ?) on conflict (key) do update set value = excluded.value", JSON.stringify(last))
  // A board with every thread archived and too few events to seal sleeps until it's next served.
  const asleep = !result.more && !rt.sql.one('select 1 from threads where archived is null limit 1') && (rt.sql.one<{ n: number }>('select count(*) as n from events')?.n ?? 0) < config.keep + config.segment
  if (asleep) stateOf(rt.board).armed = false
  else rt.timer('archive', 'board', Date.now() + (result.more ? config.pauseMs : config.everyMs))
}

// -- the routes' ops: status, settings, and a bench fill --------------------------------------------------------------

/** The Runtime the Ledger made for this board: archival status reads its storage, the bench its env. */
const runtimes = new WeakMap<Board, Runtime>()
export function remember(rt: Runtime) {
  runtimes.set(rt.board, rt)
}

const manager = (ctx: Ctx) => {
  if (!ctx.access.everywhere('manage')) throw forbidden("this token can't manage the board's archive: it needs manage everywhere")
}

/**
 * What the hot tables' rows hold, in bytes, estimated from their values' lengths plus a fixed cost a
 * row and an index entry. A Durable Object's SQLite allows no page counts, and its file keeps the
 * pages a delete frees (later writes reuse them), so databaseSize is the high-water mark; this is
 * what's live in it.
 */
function liveBytes(sql: Sql): Record<string, number> {
  const sum = (query: string) => sql.one<{ n: number | null }>(query)?.n ?? 0
  const out: Record<string, number> = {
    events: sum('select sum(length(payload) + length(facets) + length(type) + coalesce(length(actor), 0) + 40) as n from events'),
    messages: sum('select sum(2 * length(text) + length(labels) + length(reactions) + 2 * length(thread_key) + 2 * length(actor) + length(principal) + 2 * length(channel) + 2 * coalesce(length(client_key), 0) + coalesce(length(attachments), 0) + 120) as n from messages'),
    terms: sum('select sum(2 * (length(term) + 20)) as n from terms'),
    threads: sum('select sum(2 * length(channel) + coalesce(length(archived), 0) + 60) as n from threads'),
    taskViews: sum('select sum(length(view) + 24) as n from task_views'),
    coldThreads: sum('select sum(length(digest) + length(fingerprint) + 2 * length(channel) + 80) as n from cold_threads'),
    coldKeys: sum('select count(*) * 24 as n from cold_keys'),
    coldRows: sum('select sum(length(row) + 24) as n from cold_rows'),
    coldFacets: sum('select sum(length(facets) + 16) as n from cold_facets'),
    coldAuthors: sum('select sum(length(channel) + length(actor) + 8) as n from cold_authors'),
    segments: sum('select sum(length(key) + length(sha256) + 48) as n from segments'),
    frozenPages: sum('select sum(length(keys) + length(channels) + length(key) + 96) as n from frozen_pages'),
    frozenGone: sum('select count(*) * 24 as n from frozen_gone'),
    frozenFiles: sum('select sum(length(term) + 2 * length(channel) + 40) as n from frozen_files'),
  }
  out.total = Object.values(out).reduce((a, b) => a + b, 0)
  return out
}

function status(ctx: Ctx, live = false) {
  const rt = runtimes.get(ctx.board)
  const sql = ctx.sql
  const count = (query: string) => sql.one<{ n: number }>(query)?.n ?? 0
  const sealed = sql.one<{ n: number; events: number | null; bytes: number | null; through: number | null }>('select count(*) as n, sum(last - first + 1) as events, sum(bytes) as bytes, max(last) as through from segments')!
  const cold = sql.one<{ n: number; bytes: number | null; messages: number | null }>("select count(*) as n, sum(bytes) as bytes, sum(count) as messages from cold_threads where state = 'cold'")!
  return {
    head: ctx.board.head,
    config: rt ? configOf(sql, rt.env) : null,
    databaseSize: rt ? rt.storage.sql.databaseSize : null,
    ...(live ? { live: liveBytes(sql) } : {}),
    hot: { events: count('select count(*) as n from events'), messages: count('select count(*) as n from messages'), threads: count('select count(*) as n from threads'), terms: count('select count(*) as n from terms'), taskViews: count('select count(*) as n from task_views') },
    sealed: { segments: sealed.n, events: sealed.events ?? 0, bytes: sealed.bytes ?? 0, through: sealed.through ?? 0 },
    cold: { threads: cold.n, messages: cold.messages ?? 0, bytes: cold.bytes ?? 0, warm: count("select count(*) as n from cold_threads where state = 'warm'"), keys: count('select count(*) as n from cold_keys'), authors: count('select count(*) as n from cold_authors') },
    frozen: (() => {
      const pages = sql.one<{ n: number; threads: number | null; messages: number | null; bytes: number | null }>('select count(*) as n, sum(count) as threads, sum(messages) as messages, sum(bytes) as bytes from frozen_pages')!
      return { pages: pages.n, threads: pages.threads ?? 0, messages: pages.messages ?? 0, bytes: pages.bytes ?? 0, gone: count('select count(*) as n from frozen_gone'), files: count('select count(*) as n from frozen_files') }
    })(),
    cache: { segments: stateOf(ctx.board).cache.size, bytes: stateOf(ctx.board).cacheBytes, threads: stateOf(ctx.board).overlay.size, threadBytes: stateOf(ctx.board).overlayBytes, pages: stateOf(ctx.board).pageCache.size, pageBytes: stateOf(ctx.board).pageBytes },
    loads: stateOf(ctx.board).loads,
    last: JSON.parse(sql.one<{ value: string }>("select value from meta where key = 'archive_last'")?.value ?? 'null'),
    next: sql.one<{ due: number }>("select due from timers where kind = 'archive' and ref = 'board'")?.due ?? null,
  }
}

op('archive', (ctx, query: { live?: boolean }) => {
  manager(ctx)
  return status(ctx, Boolean(query.live))
}, { read: true })

export type ArchiveSettings = Partial<ArchiveConfig> & { run?: boolean; reset?: boolean; forget?: boolean }

op('configureArchive', (ctx, body: ArchiveSettings) => {
  manager(ctx)
  const own = body.reset ? {} : (JSON.parse(ctx.sql.one<{ value: string }>("select value from meta where key = 'archive'")?.value ?? '{}') as Partial<ArchiveConfig>)
  for (const key of Object.keys(LIMITS) as (keyof typeof LIMITS)[]) if (body[key] !== undefined) own[key] = clamp(key, body[key]!)
  if (body.enabled !== undefined) own.enabled = body.enabled
  ctx.sql.run("insert into meta (key, value) values ('archive', ?) on conflict (key) do update set value = excluded.value", JSON.stringify(own))
  if (body.forget) {
    // Segments read back are dropped from memory: the next read of one goes to R2.
    const state = stateOf(ctx.board)
    state.cache.clear()
    state.cacheBytes = 0
    state.overlay.clear()
    state.overlayBytes = 0
    state.pageCache.clear()
    state.pageBytes = 0
  }
  if (body.run || body.enabled) ctx.timer('archive', 'board', body.run ? ctx.now : ctx.now + (own.everyMs ?? ARCHIVE_DEFAULTS.everyMs))
  return status(ctx)
})

export type FillBody = { channel: string; threads: number; replies: number; at?: number; spanMs?: number; text?: number; keyed?: boolean; prefix?: string }

/** A bench's history, made fast: posts as the caller, through postMessage, with their time set. Only where ARCHIVE_BENCH is 1. */
op('fillArchive', (ctx, body: FillBody) => {
  const rt = runtimes.get(ctx.board)
  if (String(rt?.env.ARCHIVE_BENCH ?? '') !== '1') throw new WorkbusError(501, 'no_bench', 'this deployment makes no bench history: set ARCHIVE_BENCH to 1')
  manager(ctx)
  const total = body.threads * (1 + body.replies)
  const start = body.at ?? ctx.now
  const step = total > 1 ? (body.spanMs ?? 0) / (total - 1) : 0
  const size = body.text ?? 240
  const filler = 'the quick brown fox jumps over the lazy dog while the board keeps every word it was handed '
  let n = 0
  let first = 0
  let last = 0
  const textOf = (i: number) => {
    const head = 'bench ' + (body.prefix ?? '') + ' message ' + i + (i % 7 === 0 ? ' cc @[' + ctx.actor.id + ']' : '') + ': '
    return (head + filler.repeat(Math.ceil(size / filler.length))).slice(0, Math.max(size, head.length))
  }
  for (let t = 0; t < body.threads; t++) {
    const at = (n2: number) => ({ ...ctx, now: Math.floor(start + n2 * step) })
    const id = body.keyed ? 'bench-' + (body.prefix ?? '') + '-' + ctx.board.head + '-' + t : undefined
    const root = postMessage(at(n), { channel: body.channel, text: textOf(n), labels: { kind: 'bench', shard: String(t % 16) }, ...(id ? { id } : {}) }, { settle: false, checkBlocks: false }).row
    if (!first) first = root.id
    n++
    for (let r = 0; r < body.replies; r++) {
      const reply = postMessage(at(n), { re: String(root.id), text: textOf(n), ...(r % 3 === 0 ? { labels: { step: String(r) } } : {}), ...(id ? { id: id + '-' + r } : {}) }, { settle: false, checkBlocks: false }).row
      last = reply.id
      n++
    }
    last = Math.max(last, root.id)
  }
  return { messages: n, first, last, head: ctx.board.head }
})

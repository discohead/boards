// Registered watchers: one registration per principal, its watchers' matches queued for it to
// pull, lease, run, and ack. Matching is the registrant's own work: each pull (and each new
// registration) first reads the log from the registration's cursor (outbox 'reg:<owner>') to the
// head, in the pull's transaction, and records a match per watcher per event it may see. So a
// write to the board pays nothing for registrations, and one write is still one transaction.
import { createHash } from 'node:crypto'
import { BoardsError, forbidden, notFound } from '../errors.ts'
import { actorOf, authorOf, iso, ref, type Caller, type Facet, type Principal } from './core.ts'
import { payloadView } from './feed.ts'
import { compile, matches as facetMatches, type Compiled } from './messages.ts'
import { op, viewOptions, type Ctx } from './ops.ts'
import { json } from './sql.ts'
import type { Tail } from './tail.ts'
import { satelliteKey } from '../sync/provider.ts'

export const REGISTERED_WATCHERS_MAX = 64
export const LEASE_MS = 5 * 60 * 1000
export const TRIES = 5
export const backoff = (tries: number) => Math.min(30_000, 1000 * 2 ** (tries - 1))
const CATCH_UP_MAX = 5000
const PAGE = 200
export const SYNC_WATCHER = '@sync'

// -- small pieces both watchers and sync use ---------------------------------------------------

export const sha256 = (text: string) => createHash('sha256').update(text).digest('hex')
/** A UUIDv8 derived from a name: the same name, the same ID. */
export function derivedId(name: string): string {
  const hex = sha256(name).slice(0, 32).split('')
  hex[12] = '8'
  hex[16] = '89ab'[parseInt(hex[16]!, 16) & 3]!
  const h = hex.join('')
  return h.slice(0, 8) + '-' + h.slice(8, 12) + '-' + h.slice(12, 16) + '-' + h.slice(16, 20) + '-' + h.slice(20, 32)
}
export function leaseId(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16))
  return [...bytes].map((byte) => byte.toString(16).padStart(2, '0')).join('')
}

export type SyncEntry = { key: string; platform: string }
export type Registration = { owner: string; principal: Principal; watch: Record<string, { tail: string }>; sync: SyncEntry[]; hash: string; at: number }
type RegistrationRow = { owner: string; principal: string; watch: string; sync: string | null; hash: string; at: number }

const parseRow = (row: RegistrationRow): Registration => ({ owner: row.owner, principal: JSON.parse(row.principal), watch: JSON.parse(row.watch), sync: json<SyncEntry[]>(row.sync, []), hash: row.hash, at: row.at })

export function registrationOf(ctx: Pick<Ctx, 'sql'>, owner: string): Registration | null {
  const row = ctx.sql.one<RegistrationRow>('select * from registrations where owner = ?', owner)
  return row ? parseRow(row) : null
}

/** The sync entries a caller may name in imports, receipts, and users: a satellite's own key, or what a registrant registered. */
export function entriesOf(ctx: Pick<Ctx, 'sql' | 'caller' | 'board'>): SyncEntry[] {
  const key = satelliteKey(ctx.caller)
  if (key !== null) {
    const platform = ctx.board.sync.get(key)
    return platform === undefined ? [] : [{ key, platform }]
  }
  // A key the board's own sync has is its satellites' alone.
  return (registrationOf(ctx, ctx.caller.principal.id)?.sync ?? []).filter((entry) => !ctx.board.sync.has(entry.key))
}

/** A context for a registrant: its access worked out again now, with no profile and no narrowing. */
export function asRegistrant(ctx: Ctx, principal: Principal): Ctx {
  const caller: Caller = { principal, profile: null, narrow: null, via: 'board' }
  return { ...ctx, caller, author: authorOf(caller), actor: actorOf(caller), access: ctx.board.access(caller) }
}

// -- tails ---------------------------------------------------------------------------------------

function words(input: string): string[] {
  const out: string[] = []
  let current = ''
  let quote: string | null = null
  let started = false
  for (let i = 0; i < input.length; i++) {
    const char = input[i]!
    if (quote) {
      if (char === quote) quote = null
      else if (char === '\\' && quote === '"' && i + 1 < input.length) current += input[++i]
      else current += char
    } else if (char === '"' || char === "'") (quote = char), (started = true)
    else if (char === '\\' && i + 1 < input.length) (current += input[++i]), (started = true)
    else if (/\s/.test(char)) {
      if (started) out.push(current), (current = ''), (started = false)
    } else (current += char), (started = true)
  }
  if (quote) throw new Error('unterminated ' + quote)
  if (started) out.push(current)
  return out
}

const FLAGS: Record<string, keyof Tail | null> = { re: 're', by: 'by', mentions: 'mentions', label: 'label', source: 'from', text: 'text', for: 'for', all: null, roots: null }
const LABEL_FILTER = /^[a-z0-9][a-z0-9_.-]*(=.*)?$/

/** A watcher's tail, as the protocol reads one: throws an Error whose message is the reason. */
export function parseWatcherTail(expression: string): Tail {
  const parts = words(expression)
  const out: Tail = {}
  const labels: string[] = []
  const positional: string[] = []
  let rest = false
  for (let i = 0; i < parts.length; i++) {
    const part = parts[i]!
    if (rest || !part.startsWith('--')) {
      positional.push(part)
      continue
    }
    if (part === '--') {
      rest = true
      continue
    }
    const eq = part.indexOf('=')
    const name = eq < 0 ? part.slice(2) : part.slice(2, eq)
    const inline = eq < 0 ? undefined : part.slice(eq + 1)
    if (!Object.hasOwn(FLAGS, name)) throw new Error('--' + name + " isn't a filter")
    if (name === 'all' || name === 'roots') {
      if (inline !== undefined) throw new Error('--' + name + ' takes no value')
      if (name === 'all') out.all = true
      else out.roots = true
      continue
    }
    let value = inline
    if (value === undefined) {
      const next = parts[i + 1]
      if (name === 'mentions') {
        if (next !== undefined && !next.startsWith('-') && (next === 'me' || next.includes('@'))) (value = next), i++
        else value = 'me'
      } else {
        if (next === undefined || next.startsWith('-')) throw new Error('--' + name + ' needs a value')
        value = next
        i++
      }
    }
    if (name === 're') out.re = value.replace(/^#/, '')
    else if (name === 'by') out.by = value.replace(/^@/, '')
    else if (name === 'mentions') out.mentions = value.replace(/^@/, '')
    else if (name === 'for') out.for = value.replace(/^@/, '')
    else if (name === 'label') {
      if (!LABEL_FILTER.test(value)) throw new Error('--label: label filters look like key, key=value, or key=a|b')
      labels.push(value)
    } else if (name === 'source') {
      if (value.length < 1 || value.length > 165) throw new Error('--from: a source is 1 to 165 characters')
      out.from = value
    } else if (name === 'text') {
      if (value.length < 1 || value.length > 200) throw new Error('--text: a text filter is 1 to 200 characters')
      out.text = value
    }
  }
  if (positional.length > 1) throw new Error('expected one channel, got: ' + positional.join(' '))
  if (positional.length === 1) out.channel = positional[0]!
  if (labels.length) out.label = labels
  if (out.mentions === 'me') throw new Error('a watcher has no "me": use --mentions @handle')
  if (out.for === 'me') throw new Error('a watcher has no "me": use --for @handle')
  return out
}

/** The JSON both ends hash: watchers sorted by ID, then the sync entries sorted by key. */
export function canonicalWatchers(watch: Record<string, { tail: string }>, sync: SyncEntry[]): string {
  const out: unknown[] = Object.keys(watch).sort().map((id) => [id, watch[id]!.tail])
  if (sync.length) out.push(['sync', [...sync].sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0)).map((entry) => [entry.key, entry.platform])])
  return JSON.stringify(out)
}

// -- matching --------------------------------------------------------------------------------

type EventRow = { seq: number; type: string; thread: number | null; message: number | null; actor: string | null; at: number; payload: string; facets: string }

const WATCHED = new Set(['message.posted', 'message.edited', 'message.deleted', 'reaction.added', 'reaction.removed', 'labels.changed', 'message.sync_failed', 'message.synced', 'message.files_synced', 'thread.synced', 'task.created', 'task.assigned', 'task.needs_changed', 'task.ready', 'task.claimed', 'task.renewed', 'task.released', 'task.expired', 'task.completed', 'task.failed', 'task.blocked', 'task.unblocked', 'task.canceled', 'task.reopened'])
const RECEIPTS = new Set(['message.synced', 'message.files_synced', 'task.renewed'])
const SYNCED = new Set(['message.posted', 'message.edited', 'message.deleted', 'reaction.added', 'reaction.removed', 'labels.changed', 'thread.synced'])

type Watcher = { id: string; actor: string; all: boolean; compiled: Compiled }
type Facets = { before: Facet | null; after: Facet | null } | null

function compiledWatchers(ctx: Ctx, registration: Registration, only?: Set<string>): Watcher[] {
  const out: Watcher[] = []
  for (const [id, { tail }] of Object.entries(registration.watch)) {
    if (only && !only.has(id)) continue
    try {
      const spec = parseWatcherTail(tail)
      out.push({ id, actor: registration.owner + '+' + id.toLowerCase(), all: Boolean(spec.all), compiled: compile(ctx, spec) })
    } catch {
      // A tail that no longer compiles matches nothing.
    }
  }
  return out
}

/** The channel a @sync match is decided in: the message's, or a thread.synced's root's. */
function syncChannel(ctx: Ctx, row: EventRow, facets: Facets): string | null {
  const concerned = facets ? (facets.after ?? facets.before) : null
  if (concerned) return concerned.channel
  if (row.type === 'thread.synced' && row.thread !== null) return ctx.board.message(row.thread)?.channel ?? null
  return null
}

function watcherSees(ctx: Ctx, watcher: Watcher, row: EventRow, facets: Facets, payload: Record<string, unknown>): boolean {
  if (!WATCHED.has(row.type) || row.type === 'thread.synced') return false
  const by = (payload.by as { actor?: string } | undefined)?.actor
  if (by === watcher.actor && !(row.type === 'message.posted' && payload.schedule)) return false
  if (RECEIPTS.has(row.type) && !watcher.all) return false
  if (row.message === null || !facets) return false
  const concerned = facets.after ?? facets.before
  if (!concerned || !ctx.access.readable(concerned.channel)) return false
  if (!watcher.compiled.criteria) return true
  return facetMatches(watcher.compiled, facets.before, by ?? null) || facetMatches(watcher.compiled, facets.after, by ?? null)
}

function syncSees(ctx: Ctx, row: EventRow, facets: Facets): boolean {
  if (!SYNCED.has(row.type)) return false
  const channel = syncChannel(ctx, row, facets)
  return channel === null ? ctx.access.everywhere('sync') : ctx.access.can('sync', channel)
}

const matchId = (owner: string, watcher: string, seq: number) => derivedId('@' + owner + '/' + watcher + '\u001f' + seq)

function record(ctx: Ctx, owner: string, watcher: string, row: EventRow) {
  ctx.sql.run(
    "insert into matches (id, owner, watcher, thread, seq, state, attempts, next_at) values (?, ?, ?, ?, ?, 'pending', 0, 0) on conflict (id) do nothing",
    matchId(owner, watcher, row.seq), owner, watcher, row.thread ?? 0, row.seq,
  )
}

const cursorKey = (owner: string) => 'reg:' + owner

/** Records a registration's matches from its cursor up to the head (at most CATCH_UP_MAX events a call). */
export function catchUp(ctx: Ctx, registration: Registration, only?: { watchers: Set<string>; sync: boolean }) {
  const destination = cursorKey(registration.owner)
  const stored = ctx.sql.one<{ seq: number }>('select seq from outbox where destination = ?', destination)?.seq
  let from = stored ?? ctx.board.head
  const head = ctx.board.head
  if (from < head) {
    const rctx = asRegistrant(ctx, registration.principal)
    const watchers = compiledWatchers(rctx, registration, only?.watchers)
    const sync = registration.sync.length > 0 && (only ? only.sync : true)
    let seen = 0
    while (from < head && seen < CATCH_UP_MAX) {
      const rows = ctx.sql.all<EventRow>('select * from events where seq > ? and seq <= ? order by seq limit ?', from, head, PAGE)
      if (rows.length === 0) {
        from = head
        break
      }
      for (const row of rows) {
        if (!WATCHED.has(row.type)) continue
        const facets = JSON.parse(row.facets) as Facets
        const payload = JSON.parse(row.payload) as Record<string, unknown>
        for (const watcher of watchers) if (watcherSees(rctx, watcher, row, facets, payload)) record(ctx, registration.owner, watcher.id, row)
        if (sync && syncSees(rctx, row, facets)) record(ctx, registration.owner, SYNC_WATCHER, row)
      }
      from = rows.at(-1)!.seq
      seen += rows.length
    }
  }
  ctx.sql.run('insert into outbox (destination, seq) values (?, ?) on conflict (destination) do update set seq = excluded.seq', destination, from)
}

/** An event as a registrant sees it, or null when it can't anymore. */
function rendered(ctx: Ctx, watcher: string, row: EventRow): Record<string, unknown> | null {
  const facets = JSON.parse(row.facets) as Facets
  const payload = JSON.parse(row.payload) as Record<string, unknown>
  let messageId: number | null = row.message
  if (watcher === SYNC_WATCHER) {
    const channel = syncChannel(ctx, row, facets)
    if (channel === null ? !ctx.access.everywhere('sync') : !ctx.access.can('sync', channel)) return null
    if (row.type === 'thread.synced') messageId = row.thread
  } else {
    const concerned = facets ? (facets.after ?? facets.before) : null
    if (row.message === null ? !ctx.access.everywhere('read') : !concerned || !ctx.access.readable(concerned.channel)) return null
  }
  const view: Record<string, unknown> = { cursor: ref(row.seq), type: row.type, createdAt: iso(row.at), payload: payloadView(ctx, payload) }
  if (messageId !== null) {
    const message = ctx.board.message(messageId)
    if (message) view.message = ctx.board.view(message, viewOptions(ctx))
  }
  if (watcher === SYNC_WATCHER && row.type === 'labels.changed' && view.message && facets?.before) view.before = { ...(view.message as Record<string, unknown>), labels: facets.before.labels }
  const by = (payload.by as { actor?: string } | undefined)?.actor
  if (by) {
    const actor = ctx.board.actor(by)
    if (actor) view.actor = { id: actor.id, ...ctx.board.actorView(actor)! }
  }
  return view
}

// -- the routes ------------------------------------------------------------------------------------

const narrowedOut = () => forbidden("this token is narrowed with x-board-can: registering and running watchers is its project's job")

const registrationView = (registration: Registration) => ({ owner: registration.owner, watch: registration.watch, sync: registration.sync, hash: registration.hash, url: null })

const samePrincipal = (a: Principal, b: Principal) => a.id === b.id && a.kind === b.kind && a.handle === b.handle && a.name === b.name

/** The keys the board's own sync has: what its deployment declares (BoardsConfig.sync). */
export const ownSyncKeys = (ctx: Pick<Ctx, 'board'>): ReadonlyMap<string, string> => ctx.board.sync

type RegisterBody = { watch: Record<string, { tail: string }>; sync?: SyncEntry[]; url?: string | null; path?: string | null; branch?: string | null }

op('register', (ctx, body: RegisterBody) => {
  if (body.path !== undefined && body.path !== null) throw new BoardsError(501, 'no_wake_by_path', 'this board wakes nothing: register no path, and pull your matches')
  if (body.url !== undefined && body.url !== null) throw new BoardsError(501, 'no_wake_by_url', 'this board wakes nothing: register no url, and pull your matches')
  if (ctx.access.narrowed) throw narrowedOut()
  if (!ctx.access.anywhere('read')) throw forbidden("this token can't read anywhere, so a watcher it registers would see nothing")
  const sync = body.sync ?? []
  if (sync.length && !ctx.access.anywhere('sync')) throw forbidden("this token can't register a sync: it needs sync somewhere")
  for (const entry of sync) if (ownSyncKeys(ctx).has(entry.key)) throw new BoardsError(409, 'sync_key_taken', "this board's own sync has sync entry " + entry.key + ': give yours another key')
  const ids = Object.keys(body.watch)
  if (ids.length > REGISTERED_WATCHERS_MAX) throw new BoardsError(400, 'too_many_watchers', 'a registration holds at most ' + REGISTERED_WATCHERS_MAX + ' watchers')
  const watch: Record<string, { tail: string }> = {}
  for (const id of ids) {
    if (!/^[A-Za-z][A-Za-z0-9-]{0,31}$/.test(id)) throw new BoardsError(400, 'bad_watcher', 'watch ' + id + ': ids start with a letter and use up to 32 letters, numbers, and hyphens')
    const tail = body.watch[id]!.tail
    try {
      compile(ctx, parseWatcherTail(tail))
    } catch (error) {
      throw new BoardsError(400, 'bad_watcher', 'watch ' + id + ': ' + ((error as Error).message ?? String(error)))
    }
    watch[id] = { tail }
  }
  const principal = ctx.caller.principal
  const hash = sha256(canonicalWatchers(watch, sync)).slice(0, 32)
  const old = registrationOf(ctx, principal.id)
  const next: Registration = { owner: principal.id, principal, watch, sync, hash, at: ctx.now }
  if (old && old.hash === hash && samePrincipal(old.principal, principal)) return registrationView(old)
  if (old) {
    // What the watchers that stay would have matched so far is theirs; then everyone starts at the head.
    const staying = new Set(Object.keys(old.watch).filter((id) => watch[id]?.tail === old.watch[id]!.tail))
    catchUp(ctx, old, { watchers: staying, sync: sync.length > 0 })
    const gone = Object.keys(old.watch).filter((id) => !watch[id])
    if (!sync.length && old.sync.length) gone.push(SYNC_WATCHER)
    if (gone.length) ctx.sql.run("delete from matches where owner = ? and state = 'pending' and watcher in (select value from json_each(?))", principal.id, ctx.sql.list(gone))
  }
  const kept: Principal = { ...principal, expiresAt: null }
  ctx.sql.run(
    'insert into registrations (owner, principal, watch, sync, hash, at) values (?, ?, ?, ?, ?, ?) on conflict (owner) do update set principal = excluded.principal, watch = excluded.watch, sync = excluded.sync, hash = excluded.hash, at = excluded.at',
    principal.id, JSON.stringify(kept), JSON.stringify(watch), sync.length ? JSON.stringify(sync) : null, hash, ctx.now,
  )
  ctx.sql.run('insert into outbox (destination, seq) values (?, ?) on conflict (destination) do update set seq = excluded.seq', cursorKey(principal.id), ctx.board.head)
  return registrationView(next)
})

op('watchers', (ctx) => {
  if (ctx.access.everywhere('manage')) {
    const rows = ctx.sql.all<RegistrationRow>('select * from registrations').map(parseRow).sort((a, b) => a.owner.localeCompare(b.owner))
    return { watchers: rows.map(registrationView) }
  }
  const own = registrationOf(ctx, ctx.caller.principal.id)
  return { watchers: own ? [registrationView(own)] : [] }
}, { read: true })

type MatchRow = { id: string; owner: string; watcher: string; thread: number; seq: number; state: string; lease: string | null; until: number | null; attempts: number; next_at: number; error: string | null }

const threadKeyOf = (ctx: Ctx, root: number) => (root === 0 ? 'board' : (ctx.board.message(root)?.thread_key ?? ref(root)))

op('matches', (ctx, query: { limit?: number }) => {
  if (ctx.access.narrowed) throw narrowedOut()
  const registration = registrationOf(ctx, ctx.caller.principal.id)
  if (!registration) throw notFound('this token has no watchers registered here', 'no_registration')
  const limit = query.limit ?? 10
  // The registrant as it is now: its token's principal, not the one it registered with.
  const fresh = { ...registration, principal: ctx.caller.principal }
  catchUp(ctx, fresh)
  const rctx = asRegistrant(ctx, ctx.caller.principal)
  const now = ctx.now
  const owner = registration.owner
  const lanes = ctx.sql.all<{ watcher: string; thread: number }>("select watcher, thread, min(seq) as head from matches where owner = ? and state = 'pending' group by watcher, thread order by head", owner)
  const out: Record<string, unknown>[] = []
  for (const lane of lanes) {
    if (out.length >= limit) break
    for (;;) {
      const head = ctx.sql.one<MatchRow>("select * from matches where owner = ? and watcher = ? and thread = ? and state = 'pending' order by seq limit 1", owner, lane.watcher, lane.thread)
      if (!head) break
      const leased = head.lease !== null && head.until !== null
      if (leased && head.until! > now) break
      if (head.next_at > now) break
      if (leased && head.attempts >= TRIES) {
        ctx.sql.run("update matches set state = 'failed', lease = null, until = null, error = coalesce(error, 'its lease ran out') where id = ?", head.id)
        continue
      }
      const row = ctx.sql.one<EventRow>('select * from events where seq = ?', head.seq)
      const event = row ? rendered(rctx, head.watcher, row) : null
      if (!event) {
        // watch.skipped: its registrant can't have it anymore.
        ctx.sql.run('delete from matches where id = ?', head.id)
        continue
      }
      const lease = leaseId()
      ctx.sql.run('update matches set lease = ?, until = ?, attempts = attempts + 1 where id = ?', lease, now + LEASE_MS, head.id)
      out.push({ id: head.id, watcher: head.watcher, thread: threadKeyOf(ctx, head.thread), lease, attempt: head.attempts, event })
      break
    }
  }
  return { matches: out }
})

op('ack', (ctx, body: { id: string; lease: string; error?: string; skip?: boolean }) => {
  if (ctx.access.narrowed) throw narrowedOut()
  const row = ctx.sql.one<MatchRow>("select * from matches where id = ? and owner = ? and state = 'pending'", body.id, ctx.caller.principal.id)
  if (!row) throw notFound('no match ' + body.id + ' is waiting for this token', 'no_match')
  if (row.lease !== body.lease) throw new BoardsError(409, 'stale_lease', 'that lease ran out, and the match was pulled again')
  if (body.skip || body.error === undefined) {
    ctx.sql.run('delete from matches where id = ?', row.id)
    return { ok: true }
  }
  const error = body.error.slice(0, 500)
  if (row.attempts >= TRIES) ctx.sql.run("update matches set state = 'failed', lease = null, until = null, error = ? where id = ?", error, row.id)
  else ctx.sql.run('update matches set lease = null, until = null, next_at = ?, error = ? where id = ?', ctx.now + backoff(row.attempts), error, row.id)
  return { ok: true }
})
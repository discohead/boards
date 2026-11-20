// The Ledger: one Durable Object per board. Every protocol method is one call, and one synchronous
// transaction: the input gate keeps everything else out while it decides and writes, and the
// output gate holds its answer, and every ring and delivery it starts, until the write is durable.
import { DurableObject } from 'cloudflare:workers'
import { BoardsError, failureOf, type Failure } from '../errors.ts'
import { Board, type Caller, type Principal } from './core.ts'
import { DDL } from './schema.ts'
import { Sql } from './sql.ts'
import { ASYNC_TIMERS, OPS, READS, TIMERS, contextFor, type Ctx, type Mount, type Runtime } from './ops.ts'
import { ARCHIVE_ROUNDS, archiveBusy, beginRun, closeSession, faulted, loadFaults, openSession, prepare, remember, unlessFaulted } from './archive.ts'
import { eventView } from './feed.ts'
import { compile, type Compiled } from './messages.ts'
import { parseTail } from './tail.ts'
import type { Sink } from '../mailbox.ts'
import { courierId, type SyncProvider } from '../sync/provider.ts'
import { courierMatch } from './sync.ts'
import './messages.ts'
import './feed.ts'
import './domains.ts'

export type Answer = { ok: true; value: unknown } | { ok: false; failure: Failure }

/** Timers by kind: what the alarm runs when one is due. Each part registers its own. */
export { TIMERS }

export type WatchConfig = { tail: string; sink: Sink }
export type BoardsConfig = {
  watch?: Record<string, WatchConfig>
  /** The board's own syncs, by key: an Inbox takes each one's webhooks (/webhooks/<key>), and a courier copies what's written on the board back. */
  sync?: Record<string, SyncProvider>
}

export { courierId }

/** The board's own code, as a caller: everything, outside the grants. */
export const selfCaller = (id = 'boards:self', name = 'boards'): Caller => ({
  principal: { id, kind: 'deployment', handle: name, name, facts: null, expiresAt: null, own: true } satisfies Principal,
  profile: null,
  narrow: null,
  via: 'board',
})

export function ledgerClass<E extends { RELAY: DurableObjectNamespace<any>; MAILBOX?: DurableObjectNamespace<any> }>(configure: (env: E) => BoardsConfig = () => ({})) {
  return class Ledger extends DurableObject<E> {
    board: Board
    sql: Sql
    private config: BoardsConfig
    private watchers: { id: string; tail: Compiled | null; spec: ReturnType<typeof parseTail>; sink: Sink }[] | null = null

    constructor(ctx: DurableObjectState, env: E) {
      super(ctx, env)
      this.sql = new Sql(ctx.storage)
      ctx.blockConcurrencyWhile(async () => {
        for (const statement of DDL) ctx.storage.sql.exec(statement)
      })
      for (const statement of DDL) ctx.storage.sql.exec(statement)
      this.board = new Board(this.sql)
      this.config = configure(env)
      for (const [key, provider] of Object.entries(this.config.sync ?? {})) this.board.sync.set(key, provider.platform)
      // A watcher (and a sync's courier) sees what comes after it's deployed: mark where that is before any write lands.
      for (const id of [...Object.keys(this.config.watch ?? {}), ...Object.keys(this.config.sync ?? {}).map(courierId)]) {
        const known = this.sql.one('select seq from outbox where destination = ?', 'watch:' + id)
        if (!known && this.ctx.storage.kv.get('watchStart:' + id) === undefined) this.ctx.storage.kv.put('watchStart:' + id, this.board.head)
      }
    }

    private mount(given?: Mount): Mount {
      const known = this.ctx.storage.kv.get<Mount>('mount')
      if (known) return known
      if (!given) throw new BoardsError(500, 'no_mount', 'this board has served nothing yet')
      this.ctx.storage.kv.put('mount', given)
      return given
    }

    private timers() {
      return {
        set: (kind: string, ref: string, due: number) => {
          this.sql.run('insert into timers (kind, ref, due) values (?, ?, ?) on conflict (kind, ref) do update set due = excluded.due', kind, ref, due)
        },
        clear: (kind: string, ref: string) => {
          this.sql.run('delete from timers where kind = ? and ref = ?', kind, ref)
        },
      }
    }

    /** What a step outside any transaction gets (archival). */
    private runtime(mount: Mount): Runtime {
      const rt: Runtime = { board: this.board, sql: this.sql, storage: this.ctx.storage, env: this.env as unknown as Record<string, unknown>, mount, timer: (kind, ref, due) => this.timers().set(kind, ref, due) }
      remember(rt)
      return rt
    }

    /** One protocol method, for a caller the Gateway verified. */
    async call(caller: Caller, method: string, input: unknown, mount?: Mount): Promise<Answer> {
      const fn = OPS[method]
      if (!fn) return { ok: false, failure: { status: 404, code: 'not_found', message: 'no route: ' + method } }
      const at = this.mount(mount)
      const rt = this.runtime(at)
      const session = openSession(rt, method)
      try {
        // A run that reached archived history is thrown away, what it needs loaded, and run again.
        for (let round = 1; ; round++) {
          const after: Ctx['after'] = []
          const startHead = this.board.head
          let value: unknown
          try {
            beginRun(this.board, session)
            value = READS.has(method)
              ? unlessFaulted(this.board, fn(contextFor(this.board, caller, at, Date.now(), after, this.timers()), input))
              : this.sql.transaction(() => unlessFaulted(this.board, fn(contextFor(this.board, caller, at, Date.now(), after, this.timers()), input)))
          } catch (error) {
            // A transaction that threw wrote nothing: its positions are given back.
            this.board.head = startHead
            if (faulted(this.board)) {
              if (round >= ARCHIVE_ROUNDS) return { ok: false, failure: archiveBusy().toFailure() }
              try {
                await loadFaults(rt, session)
              } catch (loading) {
                return { ok: false, failure: failureOf(loading) }
              }
              continue
            }
            return { ok: false, failure: failureOf(error) }
          }
          await this.settle(startHead, after)
          return { ok: true, value }
        }
      } finally {
        closeSession(this.board, session)
      }
    }

    /** What a committed write starts: the next alarm, rings, watcher deliveries, and its own after-work. */
    private async settle(startHead: number, after: Ctx['after']) {
      await this.arm()
      for (const task of after) this.ctx.waitUntil(Promise.resolve().then(task).catch((error) => console.error('[boards] after a write:', error)))
      if (this.board.head > startHead) {
        this.ring()
        this.ctx.waitUntil(this.dispatch().catch((error) => console.error('[boards] dispatch:', error)))
      }
    }

    private async arm() {
      const next = this.sql.one<{ due: number | null }>('select min(due) as due from timers')?.due ?? null
      const current = await this.ctx.storage.getAlarm()
      if (next === null) {
        if (current !== null && !(this.watcherBacklog())) await this.ctx.storage.deleteAlarm()
      } else if (current === null || current > next || current < Date.now() - 1000) await this.ctx.storage.setAlarm(Math.max(next, Date.now()))
    }

    private watcherBacklog() {
      return false
    }

    async alarm(): Promise<void> {
      const mount = this.ctx.storage.kv.get<Mount>('mount')
      if (!mount) return
      prepare(this.runtime(mount))
      const started = Date.now()
      for (;;) {
        const due = this.sql.all<{ kind: string; ref: string; due: number }>('select kind, ref, due from timers where due <= ? order by due limit 25', Date.now())
        if (due.length === 0 || Date.now() - started > 10 * 60 * 1000) break
        for (const timer of due) {
          const slow = ASYNC_TIMERS[timer.kind]
          if (slow) {
            this.sql.run('delete from timers where kind = ? and ref = ? and due = ?', timer.kind, timer.ref, timer.due)
            try {
              await slow(this.runtime(mount), timer.ref)
            } catch (error) {
              console.error('[boards] timer', timer.kind, timer.ref, 'failed:', error)
              this.sql.run('insert into timers (kind, ref, due) values (?, ?, ?) on conflict (kind, ref) do nothing', timer.kind, timer.ref, Date.now() + 60_000)
            }
            continue
          }
          const handler = TIMERS[timer.kind]
          const rt = this.runtime(mount)
          const session = openSession(rt, null)
          try {
            // One that reached archived history runs again once it's back.
            for (let round = 1; ; round++) {
              const after: Ctx['after'] = []
              const startHead = this.board.head
              try {
                beginRun(this.board, session)
                this.sql.transaction(() => {
                  this.sql.run('delete from timers where kind = ? and ref = ? and due = ?', timer.kind, timer.ref, timer.due)
                  handler?.(contextFor(this.board, selfCaller(), mount, Date.now(), after, this.timers()), timer.ref)
                  unlessFaulted(this.board, null)
                })
              } catch (error) {
                this.board.head = startHead
                if (faulted(this.board) && round < ARCHIVE_ROUNDS && (await loadFaults(rt, session).then(() => true, () => false))) continue
                console.error('[boards] timer', timer.kind, timer.ref, 'failed:', error)
                // Tried again in a minute, unless something re-armed it meanwhile.
                this.sql.run('insert into timers (kind, ref, due) values (?, ?, ?) on conflict (kind, ref) do update set due = excluded.due where timers.due = ?', timer.kind, timer.ref, Date.now() + 60_000, timer.due)
              }
              await this.settle(startHead, after)
              break
            }
          } finally {
            closeSession(this.board, session)
          }
        }
      }
      await this.arm()
    }

    /** The OIDC issuers this board's grants name: the Gateway trusts their tokens. */
    async issuers(): Promise<string[]> {
      const out = new Set<string>()
      for (const grant of this.board.grants()) for (const named of grant.principals) if (named.kind === 'oidc' && typeof named.issuer === 'string') out.add(named.issuer)
      return [...out]
    }

    // -- rings: the Relays that hold this board's waits --------------------------------------
    private ringing: ReturnType<typeof setTimeout> | null = null
    private ring() {
      if (this.ringing) return
      this.ringing = setTimeout(() => {
        this.ringing = null
        const head = this.board.head
        for (const name of this.ctx.storage.kv.get<string[]>('relays') ?? [])
          this.ctx.waitUntil((this.env.RELAY as any).getByName(name).ring(head).catch((error: unknown) => console.error('[boards] ring', name, error)))
      }, 10)
    }
    async attachRelay(name: string) {
      const relays = new Set(this.ctx.storage.kv.get<string[]>('relays') ?? [])
      relays.add(name)
      this.ctx.storage.kv.put('relays', [...relays])
    }
    async detachRelay(name: string) {
      const relays = new Set(this.ctx.storage.kv.get<string[]>('relays') ?? [])
      relays.delete(name)
      this.ctx.storage.kv.put('relays', [...relays])
    }

    // -- watchers: config wiring, delivered by Mailboxes ----------------------------------------
    private compiledWatchers(ctx: Ctx) {
      if (this.watchers) return this.watchers
      this.watchers = Object.entries(this.config.watch ?? {}).map(([id, watch]) => {
        const spec = parseTail(watch.tail)
        return { id, spec, tail: compile(ctx, spec), sink: watch.sink }
      })
      return this.watchers
    }

    private dispatching: Promise<void> | null = null
    /** Hands each new event's matches to its watcher's Mailbox, in order, once each. */
    private dispatch(): Promise<void> {
      this.dispatching ??= (async () => {
        // Its body starts after the assignment, so the finally below clears this run, never one before it.
        await null
        try {
          const mount = this.ctx.storage.kv.get<Mount>('mount')
          if (!mount || !this.env.MAILBOX || (!this.config.watch && !this.config.sync)) return
          for (;;) {
            const ctx = contextFor(this.board, selfCaller(), mount, Date.now(), [], this.timers())
            const watchers = this.compiledWatchers(ctx)
            let moved = false
            // Each sync's courier: its matches, to its Mailbox, in order, once each.
            for (const key of Object.keys(this.config.sync ?? {})) {
              const id = courierId(key)
              const destination = 'watch:' + id
              const from = this.sql.one<{ seq: number }>('select seq from outbox where destination = ?', destination)?.seq
              const start = from ?? this.ctx.storage.kv.get<number>('watchStart:' + id) ?? this.firstSeen(id)
              const rows = this.sql.all<any>('select * from events where seq > ? order by seq limit 100', start)
              if (rows.length === 0) continue
              const matches: { id: string; watcher: string; thread: string; event: unknown }[] = []
              for (const row of rows) {
                const found = courierMatch(ctx, row, key)
                if (found) matches.push({ id: id + ':' + row.seq, watcher: id, thread: found.thread, event: found.event })
              }
              if (matches.length) await (this.env.MAILBOX as any).getByName(mount.name + ':' + id).enqueue(mount.name, { kind: 'sync', key } satisfies Sink, matches)
              this.sql.run('insert into outbox (destination, seq) values (?, ?) on conflict (destination) do update set seq = excluded.seq', destination, rows.at(-1).seq)
              moved = true
            }
            for (const watcher of watchers) {
              const destination = 'watch:' + watcher.id
              const from = this.sql.one<{ seq: number }>('select seq from outbox where destination = ?', destination)?.seq
              const start = from ?? this.ctx.storage.kv.get<number>('watchStart:' + watcher.id) ?? this.firstSeen(watcher.id)
              const rows = this.sql.all<any>('select * from events where seq > ? order by seq limit 100', start)
              if (rows.length === 0) continue
              const own = 'boards:watch:' + watcher.id
              const matches: { id: string; watcher: string; thread: string; event: unknown }[] = []
              for (const row of rows) {
                const by = (JSON.parse(row.payload) as { by?: { actor?: string } }).by?.actor
                const view = eventView(ctx, row, watcher.tail!, Boolean(watcher.spec.all), true)
                if (!view) continue
                const message = view.message as { schedule?: unknown; re: string | null; id: string } | undefined
                if (by === own && !(row.type === 'message.posted' && message?.schedule)) continue
                matches.push({ id: watcher.id + ':' + row.seq, watcher: watcher.id, thread: message ? (message.re ?? message.id) : 'board', event: view })
              }
              if (matches.length) await (this.env.MAILBOX as any).getByName(mount.name + ':' + watcher.id).enqueue(mount.name, watcher.sink, matches)
              this.sql.run('insert into outbox (destination, seq) values (?, ?) on conflict (destination) do update set seq = excluded.seq', destination, rows.at(-1).seq)
              moved = true
            }
            if (!moved) return
          }
        } finally {
          this.dispatching = null
        }
      })()
      return this.dispatching
    }

    /** A watcher starts at the head when it's first deployed: it sees what comes after. */
    private firstSeen(id: string): number {
      const head = this.board.head
      this.ctx.storage.kv.put('watchStart:' + id, head)
      return head
    }

    /** A watcher's write or read, from its Mailbox: as the watcher, IDs derived from the match. */
    async act(watcher: string, match: string, method: string, args: unknown[]): Promise<unknown> {
      const caller = selfCaller('boards:watch:' + watcher, watcher)
      const writes = (this.writes.get(match) ?? 0) + 1
      this.writes.set(match, writes)
      const call = (name: string, input: unknown) => this.call(caller, name, input).then((answer) => {
        if (!answer.ok) throw new BoardsError(answer.failure.status, answer.failure.code, answer.failure.message)
        return answer.value
      })
      const text = (input: unknown) => (typeof input === 'string' ? { text: input } : (input as Record<string, unknown>))
      switch (method) {
        case 'me': return call('me', {})
        case 'message': return call('message', { id: args[0] })
        case 'threads': return call('threads', args[0] ?? {})
        case 'post': return call('post', { channel: args[0], id: 'watch:' + match + ':' + writes, ...text(args[1]) })
        case 'reply': return call('post', { re: args[0], id: 'watch:' + match + ':' + writes, ...text(args[1]) })
        case 'react': return call('react', { id: args[0], emoji: args[1] })
        case 'label': return call('label', { id: args[0], ...(args[1] as object) })
        case 'typing': return call('typing', { id: args[0], ...(args[1] ? { status: args[1] } : {}) })
        default: throw new BoardsError(400, 'invalid_request', "a watcher can't " + method)
      }
    }
    private writes = new Map<string, number>()
  }
}
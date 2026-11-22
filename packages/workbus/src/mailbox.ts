// A Mailbox: one per subscriber (a watcher, or a sync's courier). The Ledger's watcher consumer hands it each match,
// in the thread's order, and goes on at once. The Mailbox delivers to the sink, one match at a time
// per thread and threads in parallel, leasing each for 5 minutes, waiting 1 second doubling to 30
// after an error, and recording a failure after 5 tries so the thread goes on. So a watcher's code,
// however slow, never holds the Ledger.
import { DurableObject, RpcTarget } from 'cloudflare:workers'
import { courier, typing } from './sync/courier.ts'
import type { SyncProvider } from './sync/provider.ts'
import type { Namespace } from './gateway/gateway.ts'
type BoardEventView = Record<string, unknown> & { cursor: string }
type Env = { LEDGER: Namespace; MAILBOX: Namespace }

/** Where a Mailbox delivers. */
export type Sink =
  /** A Worker entrypoint, by its binding's name in env: the Mailbox calls binding[method](event, context). */
  | { kind: 'service'; binding: string; method?: string }
  /** A URL, POSTed the match as JSON, signed with an HMAC of the body when there's a secret. */
  | { kind: 'url'; url: string; secret?: string }
  /** A sync's courier: the provider of the board's own sync under this key posts, edits, deletes, and reacts. */
  | { kind: 'sync'; key: string }

export type Match = { id: string; watcher: string; thread: string; event: BoardEventView }
export type Delivered = { board: string; watcher: string; match: string; attempt: number }
/** What a service sink is handed beside the event: the board as the watcher, and the board's name. */
export type DeliveredContext = Omit<Delivered, 'board'> & { board: WatcherBoard; name: string }

const TRIES = 5
const LEASE_MS = 5 * 60 * 1000
const IN_FLIGHT = 16
const backoff = (attempt: number) => Math.min(30_000, 1000 * 2 ** (attempt - 1))

/** The board, acting as the watcher, handed to a service sink: its writes are the watcher's. */
export class WatcherBoard extends RpcTarget {
  private env: Env
  private board: string
  private watcher: string
  private match: string
  constructor(env: Env, board: string, watcher: string, match: string) {
    super()
    this.env = env
    this.board = board
    this.watcher = watcher
    this.match = match
  }
  /** This delivery attempt's writes, numbered from 1: a retried delivery repeats the same IDs, so the board takes each write once. */
  private writes = 0
  private act(method: string, args: unknown[]) {
    const seq = method === 'post' || method === 'reply' ? ++this.writes : 0
    return (this.env.LEDGER as any).getByName(this.board).act(this.watcher, this.match, method, args, seq)
  }
  me() { return this.act('me', []) }
  message(id: string) { return this.act('message', [id]) }
  threads(query: unknown) { return this.act('threads', [query]) }
  post(channel: string, input: unknown) { return this.act('post', [channel, input]) }
  reply(id: string, input: unknown) { return this.act('reply', [id, input]) }
  react(id: string, emoji: string) { return this.act('react', [id, emoji]) }
  label(id: string, change: unknown) { return this.act('label', [id, change]) }
  typing(id: string, status?: string) { return this.act('typing', [id, status]) }
}

type Row = { id: string; watcher: string; thread: string; event: string; attempts: number; next_at: number; leased_until: number | null; board: string; sink: string }

export class Mailbox extends DurableObject<Env> {
  /** The board's own syncs' providers, by key: a deployment's Mailbox (mailboxClass) has them. */
  protected providers(): Record<string, SyncProvider> {
    return {}
  }

  /** Typing on each target's platform thread, from the Gateway: the courier shows it and writes nothing. */
  async typing(board: string, key: string, thread: string, targets: string[], status?: string): Promise<void> {
    const provider = this.providers()[key]
    if (!provider) return
    await typing({ ledger: (this.env.LEDGER as any).getByName(board), key, provider, thread, targets, ...(status ? { status } : {}) })
  }

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env)
    ctx.storage.sql.exec(
      'create table if not exists queue (seq integer primary key autoincrement, id text not null unique, board text not null, sink text not null, watcher text not null, thread text not null, event text not null, attempts integer not null default 0, next_at integer not null, leased_until integer, state text not null default \'pending\', error text) strict',
    )
    ctx.storage.sql.exec('create index if not exists queue_lane on queue (state, thread, seq)')
  }

  /** Takes matches, once each by ID, in the order given. */
  async enqueue(board: string, sink: Sink, matches: Match[]): Promise<void> {
    const now = Date.now()
    for (const match of matches)
      this.ctx.storage.sql.exec(
        'insert into queue (id, board, sink, watcher, thread, event, next_at) values (?, ?, ?, ?, ?, ?, ?) on conflict (id) do nothing',
        match.id, board, JSON.stringify(sink), match.watcher, match.thread, JSON.stringify(match.event), now,
      )
    await this.arm(now)
  }

  /** What's queued, delivering, and failed: for vb and tests. */
  async status(): Promise<{ pending: number; failed: { id: string; error: string | null }[] }> {
    const pending = (this.ctx.storage.sql.exec("select count(*) as n from queue where state = 'pending'").one() as { n: number }).n
    const failed = this.ctx.storage.sql.exec("select id, error from queue where state = 'failed' order by seq").toArray() as { id: string; error: string | null }[]
    return { pending, failed }
  }

  private async arm(at: number) {
    const current = await this.ctx.storage.getAlarm()
    if (current === null || current > at) await this.ctx.storage.setAlarm(Math.max(at, Date.now()))
  }

  /** Each lane's head, when it's due and no lease holds it. */
  private due(now: number): Row[] {
    return this.ctx.storage.sql.exec(
      "select q.* from queue q where q.state = 'pending' and q.seq = (select min(seq) from queue o where o.state = 'pending' and o.thread = q.thread and o.watcher = q.watcher) and q.next_at <= ? and (q.leased_until is null or q.leased_until <= ?) order by q.seq limit ?",
      now, now, IN_FLIGHT,
    ).toArray() as Row[]
  }

  async alarm(): Promise<void> {
    const started = Date.now()
    for (;;) {
      const now = Date.now()
      const due = this.due(now)
      if (due.length === 0) break
      // A lease that ran out was a try that never ended.
      await Promise.all(due.map((row) => this.deliver(row)))
      if (Date.now() - started > 10 * 60 * 1000) break
    }
    const next = this.ctx.storage.sql.exec("select min(max(next_at, coalesce(leased_until, 0))) as at from queue where state = 'pending'").one() as { at: number | null }
    if (next.at !== null) await this.ctx.storage.setAlarm(Math.max(next.at, Date.now() + 50))
  }

  private async deliver(row: Row) {
    const attempt = row.attempts + 1
    this.ctx.storage.sql.exec('update queue set attempts = ?, leased_until = ? where id = ?', attempt, Date.now() + LEASE_MS, row.id)
    try {
      await this.send(row, attempt)
      this.ctx.storage.sql.exec('delete from queue where id = ?', row.id)
    } catch (error) {
      const message = String((error as Error)?.message ?? error).slice(0, 500)
      if (attempt >= TRIES) {
        this.ctx.storage.sql.exec("update queue set state = 'failed', error = ?, leased_until = null where id = ?", message, row.id)
        console.error('[board] watch.failed', row.watcher, row.id, message)
      } else this.ctx.storage.sql.exec('update queue set next_at = ?, leased_until = null, error = ? where id = ?', Date.now() + backoff(attempt), message, row.id)
    }
  }

  private async send(row: Row, attempt: number) {
    const sink = JSON.parse(row.sink) as Sink
    const event = JSON.parse(row.event) as BoardEventView
    const context: Delivered = { board: row.board, watcher: row.watcher, match: row.id, attempt }
    if (sink.kind === 'sync') {
      const provider = this.providers()[sink.key]
      if (!provider) throw new Error('no sync ' + sink.key + ' on this deployment')
      await courier({ ledger: (this.env.LEDGER as any).getByName(row.board), key: sink.key, provider, event: event as never, last: attempt >= TRIES })
      return
    }
    if (sink.kind === 'service') {
      const target = (this.env as unknown as Record<string, Record<string, (...args: unknown[]) => Promise<unknown>>>)[sink.binding]
      if (!target) throw new Error('no binding ' + sink.binding)
      // An RPC stub: its methods are called on it, never through Function.prototype.call.
      await target[sink.method ?? 'onEvent']!(event, { ...context, name: row.board, board: new WatcherBoard(this.env, row.board, row.watcher, row.id) } satisfies DeliveredContext)
      return
    }
    const body = JSON.stringify({ event, ...context })
    const headers: Record<string, string> = { 'content-type': 'application/json', 'x-board-match': row.id }
    if (sink.secret) headers['x-board-signature'] = 'sha256=' + (await hmac(sink.secret, body))
    const response = await fetch(sink.url, { method: 'POST', headers, body })
    if (!response.ok) throw new Error(sink.url + ' answered ' + response.status)
  }
}

async function hmac(secret: string, body: string) {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'])
  const signature = new Uint8Array(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(body)))
  return [...signature].map((byte) => byte.toString(16).padStart(2, '0')).join('')
}
/** A deployment's Mailbox: its syncs' providers in hand, so the ones that are couriers can deliver. */
export function mailboxClass<E>(configure: (env: E) => { sync?: Record<string, SyncProvider> }) {
  return class extends Mailbox {
    #providers: Record<string, SyncProvider> | null = null
    protected providers(): Record<string, SyncProvider> {
      this.#providers ??= configure(this.env as unknown as E).sync ?? {}
      return this.#providers
    }
  }
}
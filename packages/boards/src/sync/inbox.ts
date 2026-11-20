// The Inbox: one per board and sync key (inbox:<board>:<key>). The Gateway hands it a webhook's
// events once the provider has verified them; it keeps each under its platform event ID (a retry
// does nothing) before the platform is answered, then its alarm imports them through the Ledger as
// the sync, one platform thread at a time, oldest first. An event gets 5 tries, 1 second apart and
// doubling; then it's recorded as failed and its thread goes on. Raw payloads stay here, for their
// retention, and never reach the board log.
import { DurableObject } from 'cloudflare:workers'
import { rootOf, satelliteCall, type InboxEvent, type SyncProvider } from './provider.ts'
export { inboxName } from './provider.ts'

export const INBOX_TRIES = 5
/** How long what's done (or failed) is kept, raw payload and all, so a platform's late retry still lands once. */
export const INBOX_RETENTION_MS = 7 * 24 * 60 * 60 * 1000
const backoff = (attempts: number) => 1000 * 2 ** (attempts - 1)
const LANES_AT_ONCE = 8

type Mount = { name: string; origin: string; url: string }
type Row = { id: string; thread: string; channel: string; event: string; raw: string | null; at: number; state: string; attempts: number; next_at: number; error: string | null }
type Env = { LEDGER: DurableObjectNamespace<any> }


export class Inbox extends DurableObject<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env)
    ctx.storage.sql.exec(
      "create table if not exists events (n integer primary key autoincrement, id text not null unique, thread text not null, channel text not null, event text not null, raw text, at integer not null, state text not null default 'pending', attempts integer not null default 0, next_at integer not null default 0, error text, done_at integer) strict",
    )
    ctx.storage.sql.exec('create index if not exists events_lane on events (state, thread, n)')
  }

  /** The board's own syncs' providers, by key: a deployment's Inbox (inboxClass) has them. */
  protected providers(): Record<string, SyncProvider> {
    return {}
  }

  /** Keeps a webhook's events, once each by ID; answered only once they're durable. */
  async push(board: string, key: string, mount: Mount, events: InboxEvent[]): Promise<{ kept: number; fresh: number }> {
    for (const event of events) if (typeof event.id !== 'string' || event.id.length < 1 || event.id.length > 300) throw new Error('an inbox event ID is 1 to 300 characters, got ' + JSON.stringify(event.id)?.slice(0, 40))
    this.ctx.storage.kv.put('where', { board, key, mount })
    const now = Date.now()
    let fresh = 0
    for (const event of events) {
      if (this.ctx.storage.sql.exec('select 1 from events where id = ?', event.id).toArray().length) continue
      this.ctx.storage.sql.exec('insert into events (id, thread, channel, event, raw, at) values (?, ?, ?, ?, ?, ?)', event.id, event.thread, event.channel, JSON.stringify(event.event), event.raw === undefined ? null : JSON.stringify(event.raw), now)
      fresh++
    }
    if (fresh) await this.arm(now)
    return { kept: events.length, fresh }
  }

  /** Puts failed events back in their lanes, all of them or the IDs named, each with 5 fresh tries: for an event a deploy's rollout or an outage refused. */
  async replay(ids?: string[]): Promise<{ replayed: number }> {
    const named = ids && ids.length ? ids : null
    const rows = this.ctx.storage.sql.exec("select id from events where state = 'failed'").toArray() as { id: string }[]
    let replayed = 0
    for (const { id } of rows) {
      if (named && !named.includes(id)) continue
      this.ctx.storage.sql.exec("update events set state = 'pending', attempts = 0, next_at = 0, error = null, done_at = null where id = ?", id)
      replayed++
    }
    if (replayed) await this.arm(Date.now())
    return { replayed }
  }

  /** What it holds: for vb inbox and tests. Newest first. */
  async list(limit = 50, channel?: string): Promise<{ id: string; thread: string; channel: string; state: string; attempts: number; error: string | null; createdAt: string; event: unknown; raw: unknown }[]> {
    const rows = this.ctx.storage.sql.exec('select * from events where (? is null or channel = ?) order by n desc limit ?', channel ?? null, channel ?? null, limit).toArray() as unknown as Row[]
    return rows.map((row) => ({ id: row.id, thread: row.thread, channel: row.channel, state: row.state, attempts: row.attempts, error: row.error, createdAt: new Date(row.at).toISOString(), event: JSON.parse(row.event), raw: row.raw === null ? null : JSON.parse(row.raw) }))
  }

  private async arm(at: number) {
    const current = await this.ctx.storage.getAlarm()
    if (current === null || current > at) await this.ctx.storage.setAlarm(Math.max(at, Date.now()))
  }

  /** Each thread's oldest pending event, when it's due. */
  private heads(now: number): Row[] {
    return this.ctx.storage.sql.exec(
      "select e.* from events e where e.state = 'pending' and e.n = (select min(n) from events o where o.state = 'pending' and o.thread = e.thread) and e.next_at <= ? order by e.n limit ?",
      now, LANES_AT_ONCE,
    ).toArray() as unknown as Row[]
  }

  async alarm(): Promise<void> {
    const where = this.ctx.storage.kv.get<{ board: string; key: string; mount: Mount }>('where')
    const provider = where ? this.providers()[where.key] : undefined
    if (where && provider) {
      const started = Date.now()
      for (;;) {
        const heads = this.heads(Date.now())
        if (heads.length === 0 || Date.now() - started > 10 * 60 * 1000) break
        await Promise.all(heads.map((row) => this.run(row, where, provider)))
      }
    }
    const now = Date.now()
    this.ctx.storage.sql.exec("delete from events where state != 'pending' and done_at < ?", now - INBOX_RETENTION_MS)
    const next = this.ctx.storage.sql.exec("select min(next_at) as at from events where state = 'pending'").one() as { at: number | null }
    if (next.at !== null && provider) await this.ctx.storage.setAlarm(Math.max(next.at, now + 50))
    else {
      const oldest = this.ctx.storage.sql.exec("select min(done_at) as at from events where state != 'pending'").one() as { at: number | null }
      if (oldest.at !== null) await this.ctx.storage.setAlarm(oldest.at + INBOX_RETENTION_MS)
    }
  }

  /** One try at importing one event, counted before it starts: a try that never ended was a try. */
  private async run(row: Row, where: { board: string; key: string; mount: Mount }, provider: SyncProvider) {
    const attempts = row.attempts + 1
    this.ctx.storage.sql.exec('update events set attempts = ? where id = ?', attempts, row.id)
    const call = satelliteCall(this.env.LEDGER.getByName(where.board) as never, where.key, 'inbox', where.mount)
    try {
      await provider.import(JSON.parse(row.event), { key: where.key, call, rootOf: (thread) => rootOf(call, thread), attempt: attempts, last: attempts >= INBOX_TRIES }).catch((error: { code?: string }) => {
        // A copy the courier made: the platform's echo of it is already on the board.
        if (error?.code !== 'already_synced') throw error
      })
      this.ctx.storage.sql.exec("update events set state = 'done', error = null, done_at = ? where id = ?", Date.now(), row.id)
    } catch (error) {
      const reason = String((error as Error)?.message ?? error).slice(0, 500)
      if (attempts >= INBOX_TRIES) {
        this.ctx.storage.sql.exec("update events set state = 'failed', error = ?, done_at = ? where id = ?", reason, Date.now(), row.id)
        console.error('[boards] sync ' + where.key + ': ' + row.id + ' failed after ' + attempts + ' tries:', reason)
      } else this.ctx.storage.sql.exec('update events set next_at = ?, error = ? where id = ?', Date.now() + backoff(attempts), reason, row.id)
    }
  }
}

/** A deployment's Inbox: its syncs' providers in hand. */
export function inboxClass<E>(configure: (env: E) => { sync?: Record<string, SyncProvider> }) {
  return class extends Inbox {
    #providers: Record<string, SyncProvider> | null = null
    protected providers(): Record<string, SyncProvider> {
      this.#providers ??= configure(this.env as unknown as E).sync ?? {}
      return this.#providers
    }
  }
}

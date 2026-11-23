// The watchdog (design/workbus.md §8.6): code notices, agents decide. One Durable Object for the
// org, fed by the app's own wake on everything it can read ('watchdog', a tail of the whole board).
// When a claim's lease runs out, a task fails, or a sync fails, it raises it to the operator, once,
// as a wake-up with the facts; the Seats raise theirs too (a session stopped for making no progress,
// a seat at its budget). It also keeps what the daily brief reports (ops/briefs/<date>): tasks done
// and failed, hires and lets-go, and what it raised. The operator decides what to do about each.
import { DurableObject } from 'cloudflare:workers'

import { bus } from '../bus.ts'
import { readOrg } from '../org/reconcile.ts'
import type { Delivered } from './seat.ts'

/** The operator's key: it stays op when the operator is renamed (§5.8). */
export const OPERATOR = 'op'

export type Raised = { kind: 'expired' | 'failed' | 'sync_failed' | 'stalled' | 'budget' | 'declined'; ref: string; thread: string; text: string }
type Fact = { cursor: string; kind: string; at: number; task: string | null; seat: string | null; text: string }

const KEEP_MS = 30 * 24 * 60 * 60 * 1000
const seatOfActor = (actor: string | null | undefined) => (actor && actor.startsWith('worker:workbus-app+') ? actor.slice('worker:workbus-app+'.length) : null)
const cut = (text: string, max = 200) => (text.length > max ? text.slice(0, max - 1) + '…' : text)

export class Watch extends DurableObject<Env> {
  sql = this.ctx.storage.sql

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env)
    ctx.blockConcurrencyWhile(async () => {
      this.sql.exec('create table if not exists facts (cursor text primary key, kind text not null, at integer not null, task text, seat text, text text not null)')
      this.sql.exec('create index if not exists facts_at on facts (at)')
      this.sql.exec('create table if not exists raised (id text primary key, kind text not null, thread text not null, text text not null, at integer not null)')
    })
  }

  #fact(fact: Fact) {
    this.sql.exec('insert or ignore into facts (cursor, kind, at, task, seat, text) values (?, ?, ?, ?, ?, ?)', fact.cursor, fact.kind, fact.at, fact.task, fact.seat, fact.text)
  }

  /** One event of the board, as the app's watchdog wake delivers it: kept for the brief, raised when it needs the operator. */
  async event(event: Delivered): Promise<{ raised: boolean }> {
    const at = event.createdAt ? Date.parse(event.createdAt) : Date.now()
    const message = event.message
    const task = message ? String(message.re ?? message.id) : event.payload?.id !== undefined ? String(event.payload.id) : null
    const where = message?.channel ? ' in ' + message.channel : ''
    const title = message?.text ? ' ("' + cut(String(message.text).split('\n')[0]!, 80) + '")' : ''
    // The event's actor, as the feed gives it: its view ({ id, … }) or its ID.
    const actor = typeof event.actor === 'string' ? event.actor : ((event.actor as { id?: string } | undefined)?.id ?? null)
    const by = seatOfActor(actor)
    // A hire the principal declined (its proposal failed or canceled): the work waiting on it stops, and the operator asks how to proceed.
    const proposal = String(message?.labels?.['board.doc.proposal'] ?? '')
    if ((event.type === 'task.canceled' || event.type === 'task.failed') && task && proposal.startsWith('new:org/seats/') && by !== OPERATOR) return { raised: await this.#declined(task, proposal.slice(4), event) }
    switch (event.type) {
      case 'task.completed':
        if (message?.labels?.['org.handoff']) await this.#handoffDone(String(message.labels['org.handoff'])).catch((error: unknown) => console.warn('watch: a handoff done', error))
        this.#fact({ cursor: event.cursor, kind: 'completed', at, task, seat: seatOfActor(message?.task?.claim?.actor) ?? seatOfActor(message?.task?.for) ?? by, text: '#' + task + where + title })
        return { raised: false }
      case 'task.failed': {
        const reason = message?.task?.reason ?? event.payload?.reason ?? ''
        this.#fact({ cursor: event.cursor, kind: 'failed', at, task, seat: by, text: '#' + task + where + title + (reason ? ': ' + cut(String(reason)) : '') })
        // The operator failing a task decided it already.
        if (by === OPERATOR || !task) return { raised: false }
        return { raised: await this.raise({ kind: 'failed', ref: event.cursor, thread: task, text: 'Task #' + task + where + title + ' failed' + (actor ? ', by ' + actor : '') + (reason ? ': ' + reason : '') + '.' }) }
      }
      case 'task.expired': {
        if (!task) return { raised: false }
        const holder = message?.task?.for ? ' It is for ' + message.task.for + '.' : ''
        this.#fact({ cursor: event.cursor, kind: 'expired', at, task, seat: seatOfActor(message?.task?.for), text: '#' + task + where + title })
        return { raised: await this.raise({ kind: 'expired', ref: event.cursor, thread: task, text: 'Task #' + task + where + title + ': its claim\'s lease ran out (claim ' + (event.payload?.epoch ?? '?') + '), so the board gave it back; it is ready again.' + holder }) }
      }
      case 'message.sync_failed': {
        const detail = cut(JSON.stringify(event.payload ?? {}), 300)
        this.#fact({ cursor: event.cursor, kind: 'sync_failed', at, task, seat: null, text: '#' + (message?.id ?? task) + where + ': ' + detail })
        return { raised: await this.raise({ kind: 'sync_failed', ref: event.cursor, thread: String(message?.re ?? message?.id ?? task ?? ''), text: 'Copying #' + (message?.id ?? task) + where + ' to its sync failed: ' + detail + '. The principal can replay the sync\'s inbox.' }) }
      }
      case 'doc.created':
        if (event.payload?.path?.startsWith('org/seats/')) this.#fact({ cursor: event.cursor, kind: 'hired', at, task: null, seat: String(event.payload.path).slice('org/seats/'.length), text: String(event.payload.path) })
        return { raised: false }
      default:
        return { raised: false }
    }
  }

  /** The work that waited on a declined hire is canceled, as its owner, and the operator is told in the proposal's thread. */
  async #declined(task: string, path: string, event: Delivered): Promise<boolean> {
    const app = bus()
    const { tasks } = (await app.tasks.list({ needs: task, state: 'open', limit: 50 })) as { tasks: { message: { id: string } }[] }
    const canceled: string[] = []
    for (const { message } of tasks) {
      try {
        await app.tasks.cancel(message.id, 'The hire it waited on, ' + path + ' (#' + task + '), was declined.')
        canceled.push('#' + message.id)
      } catch (error) {
        console.warn('watch: canceling #' + message.id + ' after a declined hire', error)
      }
    }
    const why = event.message?.task?.reason ? ' ("' + cut(String(event.message.task.reason), 160) + '")' : ''
    this.#fact({ cursor: event.cursor, kind: 'declined', at: Date.now(), task, seat: path.slice('org/seats/'.length), text: path + ', #' + task + why })
    return this.raise({ kind: 'declined', ref: event.cursor, thread: task, text: 'The principal declined the hire ' + path + ' (#' + task + ')' + why + '. ' + (canceled.length ? 'The work waiting on it was canceled: ' + canceled.join(', ') + '.' : 'No work was waiting on it.') + ' Ask the principal how to proceed, in their thread, once.' })
  }

  /**
   * The work a handoff became (its tasks labeled org.handoff) all done: the operator says so in the
   * handoff's thread, once, with what each task left.
   */
  async #handoffDone(handoff: string): Promise<void> {
    const app = bus()
    const { tasks } = (await app.tasks.list({ label: 'org.handoff=' + handoff, state: 'all', limit: 50 })) as { tasks: { message: { id: string; task: { state: string; result: string | null } } }[] }
    if (tasks.length === 0 || tasks.some(({ message }) => ['waiting', 'ready', 'claimed', 'blocked'].includes(message.task.state))) return
    const lines = tasks.map(({ message }) => '- #' + message.id + ', ' + message.task.state + (message.task.result ? ': ' + cut(message.task.result, 200) : ''))
    // As the operator by its key alone: its name and handle stay whatever the principal made them.
    await (app.as as unknown as (profile: string) => typeof app)(OPERATOR).reply(handoff, { text: 'Done: the work this handed off is finished.\n\n' + lines.join('\n'), id: 'handoff-done-' + handoff })
  }

  /** A seat retired (its seat doc gone): kept for the brief. */
  async letGo(seat: string): Promise<void> {
    this.#fact({ cursor: 'let-go:' + seat + ':' + Date.now(), kind: 'let_go', at: Date.now(), task: null, seat, text: 'org/seats/' + seat })
  }

  /** Tells the operator, once per (kind, ref): a wake-up on its Seat in the thread it concerns. */
  async raise(raised: Raised): Promise<boolean> {
    if (!raised.thread) return false
    const id = raised.kind + ':' + raised.ref
    const fresh = this.sql.exec('insert or ignore into raised (id, kind, thread, text, at) values (?, ?, ?, ?, ?)', id, raised.kind, raised.thread, raised.text, Date.now()).rowsWritten > 0
    if (!fresh) return false
    await (this.env.SEAT.getByName(OPERATOR) as unknown as { notice(notice: { id: string; thread: string; text: string }): Promise<unknown> }).notice({ id, thread: raised.thread, text: raised.text })
    this.sql.exec('delete from facts where at < ?', Date.now() - KEEP_MS)
    this.sql.exec('delete from raised where at < ?', Date.now() - KEEP_MS)
    return true
  }

  /** The daily brief's body (§5.8): the 24 hours to until, short and factual. */
  async brief(until: number, date: string): Promise<string> {
    const since = until - 24 * 60 * 60 * 1000
    const facts = this.sql.exec<Fact>('select * from facts where at >= ? and at < ? order by at', since, until).toArray()
    const raised = this.sql.exec<{ id: string; kind: string; thread: string; text: string }>('select * from raised where at >= ? and at < ? order by at', since, until).toArray()
    const of = (kind: string) => facts.filter((fact) => fact.kind === kind)
    const list = (rows: Fact[], empty: string) => (rows.length ? rows.map((row) => '- ' + row.text + (row.seat ? ' (' + row.seat + ')' : '')).join('\n') : empty)
    const seats = await this.#seats(since)
    const held = await this.#held(seats)
    const lines = [
      '# Brief, ' + date,
      '',
      'The 24 hours to ' + new Date(until).toISOString().slice(0, 16).replace('T', ' ') + ' UTC.',
      '',
      '## Done',
      '',
      of('completed').length ? of('completed').length + (of('completed').length === 1 ? ' task' : ' tasks') + ' completed:\n\n' + list(of('completed'), '') : 'No tasks completed.',
      '',
      '## Failed',
      '',
      list(of('failed'), 'No tasks failed.'),
      '',
      '## Seats',
      '',
      'Hired: ' + (of('hired').map((row) => row.seat).join(', ') || 'none') + '. Let go: ' + (of('let_go').map((row) => row.seat).join(', ') || 'none') + '.',
      '',
      '| Seat | State | Runs | Spend, 24h | This month | Budget |',
      '| --- | --- | --- | --- | --- | --- |',
      ...seats.map((seat) => '| ' + seat.key + ' | ' + seat.state + ' | ' + seat.runs + ' | $' + seat.day.toFixed(4) + ' | $' + seat.month.toFixed(4) + ' | ' + (seat.budget === null ? 'none' : '$' + seat.budget) + ' |'),
      '',
      '## Held for you',
      '',
      held.length ? held.map((one) => '- ' + one).join('\n') : 'Nothing.',
      '',
      '## Raised by the watchdog',
      '',
      raised.length ? raised.map((one) => '- ' + one.kind + ', #' + one.thread + ': ' + one.text).join('\n') : 'Nothing.',
      '',
    ]
    return lines.join('\n')
  }

  /** Each seat's state and spend: the day's from its runs, the month's from its totals. */
  async #seats(since: number) {
    const keys = (await readOrg(bus())).filter((doc) => doc.channel === 'org/seats').map((doc) => doc.slug).sort()
    return Promise.all(
      keys.map(async (key) => {
        const stub = this.env.SEAT.getByName(key) as unknown as { status(): Promise<any>; spentSince(since: string): Promise<{ runs: number; cost: number }> }
        const [status, day] = await Promise.all([stub.status(), stub.spentSince(new Date(since).toISOString())])
        return { key, state: String(status.state), runs: day.runs, day: day.cost, month: status.spend?.cost ?? 0, budget: status.runtime?.budget?.month ?? null, status }
      }),
    )
  }

  /** What waits on the principal: tasks held (blocked) that the app sees, and each seat's own holds (approvals, budget). */
  async #held(seats: { key: string; status: any }[]): Promise<string[]> {
    const out: string[] = []
    const seen = new Set<string>()
    const { tasks } = await bus().tasks.list({ state: 'blocked', limit: 100 })
    for (const { message } of tasks as { message: any }[]) {
      seen.add(String(message.id))
      out.push('#' + message.id + ' in ' + message.channel + ', ' + (message.task.blocked?.kind ?? 'held') + ': ' + cut(String(message.task.blocked?.reason ?? message.text).split('\n')[0]!, 120))
    }
    for (const seat of seats) {
      for (const hold of (seat.status.holds ?? []) as { task: string; thread: string; state: string }[]) if (hold.state === 'held' && !seen.has(hold.task)) (seen.add(hold.task), out.push('#' + hold.task + ', approval: ' + seat.key + ' waits to run a step in #' + hold.thread))
      for (const task of (seat.status.budget?.tasks ?? []) as { task: string; kind: string; open: number }[]) if (task.open && !seen.has(task.task)) (seen.add(task.task), out.push('#' + task.task + ', budget: ' + seat.key + "'s " + (task.kind === 'limit' ? 'limit' : 'alert')))
    }
    return out
  }
}

// A seat's runtime (design/workbus.md §5.2): one Durable Object per seat, named by its key. It
// holds the config the reconciler gave it (and the revision it came from), its wake queue
// (deduplicated by wake and event cursor), the approvals its sessions hold, and its spend.
// It routes each wake-up to its thread's session through the harness seam (harness/types.ts),
// starting at most `sessions` at once and queueing the rest; none while paused or over budget. A
// thread already running takes its next wake-ups at once (its session orders them as follow-ups),
// and a session parked on an approval frees its slot. When an operation ends, the Seat writes its
// run record (§8.2, telemetry/), which keeps the month's spend and sends the record to Basin.
import { DurableObject } from 'cloudflare:workers'

import { PiHarnessAdapter } from '../harness/pi.ts'
import type { Outcome, SeatRef, ToolAnswer, ToolTier, Turn } from '../harness/types.ts'
import type { SeatRuntime } from '../org/rules.ts'
import { record, runOf, Totals, type Run } from '../telemetry/index.ts'
import { bus } from '../bus.ts'
import { seatBoard } from '../org/reconcile.ts'
import { budgetStep, budgetText, nextPeriod, periodOf, usd, type BudgetKind, type BudgetTasks } from './budget.ts'
import { RUNNING_UNHELD, WAKES_DDL } from './queue.ts'
import { render } from './turn.ts'

export type SeatState = 'active' | 'working' | 'waiting' | 'paused' | 'over_budget' | 'retired'

/** What a wake delivers (design/registered-watchers.md), as the Wake entrypoint hands it on. */
export type Delivered = { cursor: string; type: string; createdAt?: string; payload?: any; message?: any; actor?: string }
export type DeliveredContext = { board: string; wake: string; principal: string; actor: string; rules: string[]; match: string; attempt: number }

type Input = Turn | ToolAnswer
type WakeRow = { id: string; thread: string; task: string | null; input: string; state: 'queued' | 'running' | 'held' | 'done' | 'failed'; attempts: number; error: string | null; at: number; started: number | null; ended: number | null }

const TRIES = 5
const RETRY_MS = 2_000
/** While anything runs, the alarm comes back this often to follow operations an eviction let go of. */
const FOLLOW_MS = 60_000
const KEEP_MS = 7 * 24 * 60 * 60 * 1000

/** The thread an event is in: its message's root, or the message a task or doc event names. */
export function threadOf(event: Delivered): string | null {
  const message = event.message
  if (message && typeof message.id === 'string') return message.re ?? message.id
  const id = event.payload?.root ?? event.payload?.id ?? event.payload?.message
  return id === undefined || id === null ? null : String(id)
}

/** The principal's answer to a hold, if this event is one: the task, approved or not, and the note. */
export function answerOf(event: Delivered): { task: string; approved: boolean; note?: string } | null {
  const decision = event.payload?.decision
  if (decision !== 'approved' && decision !== 'declined') return null
  const task = event.payload?.id ?? event.message?.id
  if (task === undefined || task === null) return null
  return { task: String(task), approved: decision === 'approved', ...(typeof event.payload?.note === 'string' ? { note: event.payload.note } : {}) }
}

/** The seam's view of a seat (harness/types.ts), from the reconciler's runtime. */
export function seatRef(runtime: SeatRuntime): SeatRef {
  return {
    key: runtime.key,
    name: runtime.name,
    handle: runtime.handle,
    ...(runtime.avatar ? { avatar: runtime.avatar } : {}),
    team: runtime.team ?? '',
    can: runtime.can,
    tools: runtime.tools as ToolTier[],
    prompt: { charter: runtime.charter, ...(runtime.teamDoc ? { team: runtime.teamDoc } : {}), ...(runtime.structure ? { org: runtime.structure } : {}) },
    revision: String(runtime.configRevision),
    ...(Object.keys(runtime.approve ?? {}).length ? { approve: runtime.approve } : {}),
    ...(runtime.automatic?.length ? { automatic: runtime.automatic } : {}),
  }
}

export class Seat extends DurableObject<Env> {
  sql = this.ctx.storage.sql
  /** Its run records (telemetry/): its spend, and what goes to Basin. */
  totals: Totals
  /** Operations this instance is waiting on now: the alarm re-follows the rest. */
  #following = new Set<string>()

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env)
    ctx.blockConcurrencyWhile(async () => {
      this.sql.exec(WAKES_DDL)
      this.sql.exec('create index if not exists wakes_state on wakes (state, at)')
      this.sql.exec('create table if not exists holds (task text primary key, thread text not null, operation text, state text not null, at integer not null)')
      this.sql.exec('create table if not exists budget_tasks (task text primary key, period text not null, kind text not null, open integer not null, at integer not null)')
    })
    this.totals = new Totals(this.sql)
  }

  get runtime(): SeatRuntime | null {
    return this.ctx.storage.kv.get<SeatRuntime>('runtime') ?? null
  }

  #one<T>(query: string, ...bindings: unknown[]): T | undefined {
    return this.sql.exec(query, ...bindings).toArray()[0] as T | undefined
  }

  /** The reconciler's apply: a revision older than the one held changes nothing. null retires the seat. */
  async configure(runtime: SeatRuntime | null, revision: number): Promise<{ applied: boolean; revision: number; state: SeatState }> {
    const held = this.ctx.storage.kv.get<number>('revision') ?? -1
    if (runtime !== null && revision < held) return { applied: false, revision: held, state: this.state() }
    const same = runtime === null ? this.runtime === null : revision === held && JSON.stringify(runtime) === JSON.stringify(this.runtime)
    if (!same) {
      if (runtime === null) this.ctx.storage.kv.delete('runtime')
      else {
        this.ctx.storage.kv.put('runtime', runtime)
        this.ctx.storage.kv.put('revision', revision)
        this.ctx.storage.kv.put('key', runtime.key)
      }
    }
    // A raised budget closes the held limit task, and the seat runs again.
    if (runtime) await this.#budget(runtime)
    await this.pump()
    return { applied: !same, revision: this.ctx.storage.kv.get<number>('revision') ?? -1, state: this.state() }
  }

  /** A delivery: queued once per (wake, cursor), then routed. An answer to a hold goes to the session it holds. */
  async wake(event: Delivered, context: DeliveredContext): Promise<{ queued: boolean; thread: string | null; answer?: string }> {
    // A doc made, edited, or moved is news only to a seat that wakes for docs ({ docs: <channel> }): a
    // mention or a follow in a doc's body isn't a message to the seat. Comments on a doc are posts, and still wake it.
    if (event.type.startsWith('doc.') && !context.rules.includes('docs')) return { queued: false, thread: threadOf(event) }
    const id = context.wake + ':' + event.cursor
    const answer = answerOf(event)
    // A budget task it holds for the principal is theirs: an answer is noted, nothing about it starts a turn.
    const budgetTask = this.#one<{ task: string; kind: BudgetKind; open: number }>('select task, kind, open from budget_tasks where task = ?', answer?.task ?? threadOf(event) ?? '')
    if (budgetTask) {
      if (answer && budgetTask.open) await this.#answered(budgetTask.task, budgetTask.kind, answer.approved)
      return { queued: false, thread: budgetTask.task }
    }
    const hold = answer ? this.#one<{ thread: string; state: string }>('select thread, state from holds where task = ?', answer.task) : undefined
    let thread: string | null
    let input: Input
    if (answer && hold) {
      thread = hold.thread
      input = { type: 'approval', approvalId: answer.task, approved: answer.approved, ...(answer.note ? { reason: answer.note } : {}) }
    } else {
      thread = threadOf(event)
      if (thread === null) {
        console.warn('seat: an event with no thread', event.type, event.cursor)
        return { queued: false, thread }
      }
      // A task one of its sessions holds for the principal is theirs to answer, never work for this
      // seat: nothing about it but the answer starts a turn (its ready event in a queue the seat serves included).
      if (this.#one('select 1 as there from holds where task = ?', thread)) return { queued: false, thread }
      input = { type: 'turn', parts: [{ type: 'text', text: render(event, context.rules, thread) }] }
    }
    // The task it's about, for its run record: a task's own thread, or the held task an answer is for.
    const task = answer && hold ? answer.task : event.message?.task ? String(event.message.re ?? event.message.id) : null
    const result = this.sql.exec('insert or ignore into wakes (id, thread, task, input, state, at) values (?, ?, ?, ?, ?, ?)', id, thread, task, JSON.stringify(input), 'queued', Date.now())
    if (result.rowsWritten > 0) await this.pump()
    return { queued: result.rowsWritten > 0, thread, ...(answer && hold ? { answer: answer.task } : {}) }
  }

  /** A session's word that a call is parked on a task held for the principal (§6.2). */
  async held(hold: { approvalId: string; thread: string; operationId?: string | null }): Promise<void> {
    this.sql.exec("insert or ignore into holds (task, thread, operation, state, at) values (?, ?, ?, 'held', ?)", hold.approvalId, hold.thread, hold.operationId ?? null, Date.now())
    if (hold.operationId) this.sql.exec("update wakes set state = 'held' where id = ? and state = 'running'", hold.operationId)
    await this.pump()
  }

  /** An operation's end: its slot is free, its run recorded and its cost spent (telemetry/), once per operation. */
  async ended(operationId: string, outcome: Outcome | null, error?: string): Promise<void> {
    const row = this.#one<WakeRow>('select * from wakes where id = ?', operationId)
    if (!row || row.state === 'done' || row.state === 'failed') return
    const now = Date.now()
    const runtime = this.runtime
    this.sql.exec('update wakes set state = ?, ended = ?, error = ? where id = ?', outcome === null ? 'failed' : 'done', now, error ?? outcome?.reason ?? null, row.id)
    const input = JSON.parse(row.input) as Input
    if (input.type === 'approval') this.sql.exec("update holds set state = 'answered' where task = ? and state = 'held'", input.approvalId)
    // A start or a wait that failed outright ran nothing the Seat can measure: a failed run, with its error.
    const ended = outcome ?? {
      operationId,
      status: 'unanswered' as const,
      reason: error ?? 'failed',
      usage: { model: null, steps: 0, tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, cost: 0, tools: [], logs: [], started: new Date(row.started ?? row.at).toISOString(), ended: new Date(now).toISOString() },
    }
    const key = runtime?.key ?? this.ctx.storage.kv.get<string>('key') ?? 'unknown'
    // An approval's answer only resumes the held operation, whose own record carries the work: runOf answers null for it.
    const run = runOf(ended, { seat: key, team: runtime?.team ?? null, thread: row.thread, task: row.task, charter: String(this.ctx.storage.kv.get<number>('revision') ?? '') || null })
    if (run) {
      const recorded = await record(this.totals, this.env.RUNS, run)
      if (recorded.error) console.error('seat ' + key + ': run ' + run.id + ' kept, not yet sent to Basin:', recorded.error)
    }
    if (runtime) await this.#budget(runtime)
    await this.pump()
  }

  /**
   * Send its runs to Basin again (all, or those that ended at or after `since`): a backfill, as for
   * runs sent before the stream had a sink. Basin queries count each run id once, so it can't double a cost.
   */
  async resendRuns(since?: string): Promise<{ marked: number; sent: number }> {
    const marked = this.totals.resend(since)
    return { marked, sent: await this.totals.flush(this.env.RUNS) }
  }

  /** Holds and closes its budget tasks as its spend and budget say (budget.ts), one step at a time. */
  async #budget(runtime: SeatRuntime): Promise<void> {
    const now = Date.now()
    const period = periodOf(now)
    for (let steps = 0; steps < 4; steps++) {
      // An open task from an earlier period comes first: a new period closes it.
      const stale = this.#one<{ period: string }>('select period from budget_tasks where open = 1 and period != ? order by at limit 1', period)
      const at = stale?.period ?? period
      const held: BudgetTasks = { period: at }
      for (const row of this.sql.exec<{ task: string; kind: BudgetKind; open: number }>('select task, kind, open from budget_tasks where period = ?', at).toArray()) held[row.kind] = { task: row.task, open: row.open === 1 }
      const spend = this.totals.spend(runtime.key, period).cost
      const step = budgetStep(spend, runtime.budget, held, period)
      if (!step) return
      try {
        if ('close' in step) {
          const task = held[step.close]!.task
          const note = step.why === 'period' ? 'A new period started, and ' + runtime.name + "'s budget with it." : runtime.name + "'s budget was raised to " + usd(runtime.budget.month ?? 0) + ', and it runs again.'
          const tasks = seatBoard(bus(), runtime).tasks
          // Held for the principal still: the seat lifts its own hold, then ends the task with why.
          await tasks.unblock(task).catch(() => undefined)
          await tasks.complete(task, note).catch((error: unknown) => console.warn('seat ' + runtime.key + ': closing budget task #' + task, error))
          this.sql.exec('update budget_tasks set open = 0 where task = ?', task)
        } else {
          const waiting = (this.#one<{ n: number }>("select count(*) as n from wakes where state = 'queued'")?.n ?? 0)
          const words = budgetText(step.hold, runtime, spend, runtime.budget.month!, period, waiting)
          const tasks = seatBoard(bus(), runtime).tasks
          const made = await tasks.create({ channel: 'dm/' + runtime.key, text: words.text, id: 'budget-' + runtime.key + '-' + period + '-' + step.hold })
          const task = String(made.task.id)
          await tasks.block(task, words.reason, 'budget').catch((error: unknown) => {
            // Made by an earlier try and held already: that's what this step wanted.
            if (!/already|task_blocked|blocked/.test(String(error))) throw error
          })
          this.sql.exec('insert or replace into budget_tasks (task, period, kind, open, at) values (?, ?, ?, 1, ?)', task, period, step.hold, now)
        }
      } catch (error) {
        console.error('seat ' + runtime.key + ': budget step ' + JSON.stringify(step) + ' failed', error)
        // Kept for status(): the seat's page and the checks see why a budget task didn't come.
        this.ctx.storage.kv.put('budgetError', { at: new Date(now).toISOString(), step, error: String(error) })
        return
      }
    }
  }

  /** The principal answered a budget task: an alert is noted and ends; the limit holds again while the budget still says so. */
  async #answered(task: string, kind: BudgetKind, approved: boolean): Promise<void> {
    const runtime = this.runtime
    if (!runtime) return
    const tasks = seatBoard(bus(), runtime).tasks
    try {
      if (kind === 'limit' && this.state() === 'over_budget') {
        await tasks.block(task, 'Still over budget: answering this task doesn\'t raise it. Raise budget.month in org/seats/' + runtime.key + ' to let ' + runtime.name + ' run again.', 'budget')
        return
      }
      await tasks.complete(task, approved ? 'Noted by the principal.' : 'Dismissed by the principal.')
      this.sql.exec('update budget_tasks set open = 0 where task = ?', task)
    } catch (error) {
      console.error('seat ' + runtime.key + ': answering budget task #' + task + ' failed', error)
    }
  }

  /** This month's spend, in USD, from its runs. */
  spend(): number {
    const key = this.runtime?.key
    return key ? this.totals.spend(key).cost : 0
  }

  state(): SeatState {
    const runtime = this.runtime
    if (!runtime) return 'retired'
    if (runtime.state === 'paused') return 'paused'
    if (runtime.budget.month !== null && this.spend() >= runtime.budget.month) return 'over_budget'
    // A wake running in a thread whose session is parked on a hold waits behind it: that thread is waiting, not working.
    if (this.#one(RUNNING_UNHELD)) return 'working'
    if (this.#one("select 1 as there from wakes where state = 'held'")) return 'waiting'
    return 'active'
  }

  /** What the app's views show: who, its state, its queue, its holds, its spend, and its last runs. */
  async status() {
    const runtime = this.runtime
    const queue = Object.fromEntries(this.sql.exec<{ state: string; n: number }>('select state, count(*) as n from wakes group by state').toArray().map((row) => [row.state, row.n]))
    const holds = this.sql.exec('select task, thread, operation, state from holds order by at desc limit 20').toArray()
    const runs = this.sql.exec<{ record: string }>('select record from telemetry_runs order by rowid desc limit 20').toArray().map((row) => JSON.parse(row.record) as Run)
    const wakes = this.sql.exec('select id, thread, state, attempts, error from wakes order by at desc limit 20').toArray()
    const spend = runtime ? this.totals.spend(runtime.key) : null
    const budget = { tasks: this.sql.exec('select task, period, kind, open from budget_tasks order by at desc limit 12').toArray(), error: this.ctx.storage.kv.get('budgetError') ?? null }
    return { seat: runtime?.key ?? null, revision: this.ctx.storage.kv.get<number>('revision') ?? null, state: this.state(), runtime, queue, wakes, holds, spend: spend && { ...spend, budget: runtime!.budget.month }, runs, budget }
  }

  #pumping = false
  #again = false

  /** Starts what it can, one pass at a time: every wake-up for a thread already running, then new threads while a session is free. */
  async pump(): Promise<void> {
    if (this.#pumping) {
      this.#again = true
      return
    }
    this.#pumping = true
    try {
      do {
        this.#again = false
        await this.#pass()
      } while (this.#again)
    } finally {
      this.#pumping = false
    }
  }

  async #pass(): Promise<void> {
    const runtime = this.runtime
    if (!runtime) return
    const state = this.state()
    if (state === 'paused') return
    if (state === 'over_budget') {
      // Its queue waits for a raised budget, or for the next period, when the alarm looks again.
      const next = nextPeriod(Date.now())
      const armed = await this.ctx.storage.getAlarm()
      if (armed === null || armed > next) await this.ctx.storage.setAlarm(next)
      return
    }
    // A parked session doesn't hold a slot, nor do the wakes waiting behind it in its thread; a running one does.
    const running = new Set(this.sql.exec<{ thread: string }>(RUNNING_UNHELD).toArray().map((row) => row.thread))
    const open = new Set([...running, ...this.sql.exec<{ thread: string }>("select distinct thread from wakes where state = 'held'").toArray().map((row) => row.thread)])
    const queued = this.sql.exec<WakeRow>("select * from wakes where state = 'queued' order by at, id").toArray()
    let next: number | null = null
    for (const row of queued) {
      if (!open.has(row.thread)) {
        if (running.size >= runtime.sessions) continue
        running.add(row.thread)
        open.add(row.thread)
      }
      const wait = row.attempts > 0 ? RETRY_MS * 2 ** (row.attempts - 1) - (Date.now() - row.at) : 0
      if (wait > 0) {
        next = Math.min(next ?? Infinity, Date.now() + wait)
        continue
      }
      await this.#start(runtime, row)
    }
    this.sql.exec("delete from wakes where state in ('done', 'failed') and at < ?", Date.now() - KEEP_MS)
    if (this.#one('select 1 as there from wakes where state in (\'running\', \'held\')')) next = Math.min(next ?? Infinity, Date.now() + FOLLOW_MS)
    if (next !== null) {
      const armed = await this.ctx.storage.getAlarm()
      if (armed === null || armed > next) await this.ctx.storage.setAlarm(next)
    }
  }

  async #start(runtime: SeatRuntime, row: WakeRow): Promise<void> {
    this.sql.exec("update wakes set state = 'running', started = ?, attempts = attempts + 1 where id = ?", Date.now(), row.id)
    try {
      const session = await new PiHarnessAdapter(this.env.SESSION).open(seatRef(runtime), row.thread)
      const input = JSON.parse(row.input) as Input
      await session.submit(input, { operationId: row.id, ...(row.task ? { task: row.task } : {}) })
      if (input.type === 'approval') {
        // The held operation goes on: it's running again until it ends.
        const hold = this.#one<{ operation: string | null }>('select operation from holds where task = ?', input.approvalId)
        if (hold?.operation) this.sql.exec("update wakes set state = 'running' where id = ? and state = 'held'", hold.operation)
        await this.#close(runtime, input)
      }
      this.ctx.waitUntil(this.#follow(runtime, row.id, row.thread))
    } catch (error) {
      const tries = row.attempts + 1
      console.error('seat ' + runtime.key + ': starting ' + row.id + ' failed (try ' + tries + ')', error)
      this.sql.exec('update wakes set state = ?, error = ?, at = ? where id = ?', tries >= TRIES ? 'failed' : 'queued', String(error), Date.now(), row.id)
      if (tries < TRIES) await this.ctx.storage.setAlarm(Date.now() + RETRY_MS * 2 ** (tries - 1))
    }
  }

  /**
   * Ends an answered hold's task once its session has the answer, so it never stays open work in a
   * queue: completed with the decision when approved, canceled with it when declined. The seat ends
   * it as the task's owner. A task already ended (a redelivery) is left as it is.
   */
  async #close(runtime: SeatRuntime, answer: ToolAnswer): Promise<void> {
    const note = answer.reason ? ': ' + answer.reason : ''
    try {
      const tasks = seatBoard(bus(), runtime).tasks
      if (answer.approved) await tasks.complete(answer.approvalId, 'Approved by the principal' + note)
      else await tasks.cancel(answer.approvalId, 'Declined by the principal' + note)
      this.sql.exec("update holds set state = 'closed' where task = ?", answer.approvalId)
    } catch (error) {
      console.error('seat ' + runtime.key + ': ending the answered hold #' + answer.approvalId + ' failed', error)
    }
  }

  /** Waits for an operation to end, then ends it here. A wait that times out (a long hold) is picked up again by the alarm. */
  async #follow(runtime: SeatRuntime, operationId: string, thread: string): Promise<void> {
    if (this.#following.has(operationId)) return
    this.#following.add(operationId)
    try {
      const session = await new PiHarnessAdapter(this.env.SESSION).open(seatRef(runtime), thread)
      const outcome = await session.wait(operationId)
      await this.ended(operationId, outcome)
    } catch (error) {
      const message = String(error)
      if (/timeout|timed out|aborted due to timeout/i.test(message)) return
      console.error('seat ' + runtime.key + ': ' + operationId + ' failed', error)
      await this.ended(operationId, null, message)
    } finally {
      this.#following.delete(operationId)
    }
  }

  async alarm(): Promise<void> {
    const runtime = this.runtime
    if (runtime)
      for (const row of this.sql.exec<WakeRow>("select * from wakes where state in ('running', 'held')").toArray())
        if (!this.#following.has(row.id)) this.ctx.waitUntil(this.#follow(runtime, row.id, row.thread))
    // A new period starts its budget over: the limit task closes, and the queue runs.
    if (runtime) await this.#budget(runtime)
    await this.pump()
  }
}

// A seat's runtime (design/workbus.md §5.2): one Durable Object per seat, named by its key. It
// holds the config the reconciler gave it (and the revision it came from), its wake queue
// (deduplicated by wake and event cursor), the approvals its sessions hold, and its spend.
// It routes each wake-up to its thread's session through the harness seam (harness/types.ts),
// starting at most `sessions` at once and queueing the rest; none while paused or over budget. A
// thread already running takes its next wake-ups at once (its session orders them as follow-ups),
// and a session parked on an approval frees its slot. When an operation ends, the Seat writes its
// run record (§8.2, telemetry/), which keeps the month's spend and sends the record to Basin.
import { DurableObject } from 'cloudflare:workers'
import { getAgentByName } from 'agents'

import { PiHarnessAdapter, sessionName } from '../harness/pi.ts'
import type { Outcome, RequestHint, SeatRef, ToolAnswer, ToolTier, Turn } from '../harness/types.ts'
import type { SeatRuntime } from '../org/rules.ts'
import { record, runOf, Totals, type Run } from '../telemetry/index.ts'
import { bus } from '../bus.ts'
import { BRIEFS, seatBoard } from '../org/reconcile.ts'
import { budgetStep, budgetText, monthName, nextPeriod, periodOf, usd, type BudgetKind, type BudgetTasks } from './budget.ts'
import { RUNNING_UNHELD, WAKES_DDL } from './queue.ts'
import { REQUEST, requestOf } from './request.ts'
import { OPERATOR, type Raised } from './watch.ts'
import { render } from './turn.ts'

/** Which code this Seat runs, in its status(): after a deploy, a check waits until the Seats answer with this. Bump it with each change a check depends on. */
export const SEAT_CODE = 'let-go-2026-11-24.1'

export type SeatState = 'active' | 'working' | 'waiting' | 'paused' | 'over_budget' | 'retired'

/** What a wake delivers (design/registered-watchers.md), as the Wake entrypoint hands it on. */
export type Delivered = { cursor: string; type: string; createdAt?: string; payload?: any; message?: any; actor?: unknown }
export type DeliveredContext = { board: string; wake: string; principal: string; actor: string; rules: string[]; match: string; attempt: number }

type Input = Turn | ToolAnswer
type WakeRow = { id: string; thread: string; task: string | null; input: string; state: 'queued' | 'running' | 'held' | 'done' | 'failed'; attempts: number; error: string | null; at: number; started: number | null; ended: number | null; request?: string | null }

const TRIES = 5
const RETRY_MS = 2_000
/** While anything runs, the alarm comes back this often to follow operations an eviction let go of. */
const FOLLOW_MS = 60_000
const KEEP_MS = 7 * 24 * 60 * 60 * 1000
/** How long a running operation may go before the Seat stops it (§8.6); WATCHDOG_STALL_MS overrides it. */
const STALL_MS = 15 * 60 * 1000
const RAISED_BY_WATCHDOG = new Set(['task.failed', 'task.expired', 'message.sync_failed'])
const watch = (env: Env) => env.WATCH.getByName('bus') as unknown as { raise(raised: Raised): Promise<boolean>; letGo(seat: string): Promise<void> }

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

/** Where a new seat introduces itself: its team's channel (the team's key), or the org's. */
export const introChannel = (runtime: Pick<SeatRuntime, 'team' | 'can'>) => {
  const team = runtime.team
  // Its team's channel when it may post there (eng for eng/), else the org's.
  const grants = Object.entries(runtime.can ?? {})
  const posts = (grant: unknown) => grant === 'all' || (Array.isArray(grant) && (grant.includes('post') || grant.includes('manage')))
  return team && grants.some(([pattern, grant]) => (pattern === team || pattern === team + '/') && posts(grant)) ? team : 'org'
}

/** The turn a new seat's first session reads: say who it is, where it's heard, and stop. */
export function introduction(runtime: SeatRuntime): Turn {
  const text = [
    'You were just hired: you are ' + runtime.name + ' (@' + runtime.handle + ')' + (runtime.role ? ', a ' + runtime.role : '') + (runtime.team ? ', on the team ' + runtime.team : '') + '.',
    'Introduce yourself, in two short sentences at most: who you are and what to ask you for, from your charter.',
    'Post it once in the channel ' + introChannel(runtime) + ' (board_post), and once in your DM, dm/' + runtime.key + '. Then stop: nothing else needs doing now.',
  ].join('\n')
  return { type: 'turn', parts: [{ type: 'text', text }] }
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
    ...(runtime.assigns ? { assigns: runtime.assigns } : {}),
    ...(runtime.escalates ? { escalates: runtime.escalates } : {}),
    ...(runtime.consults?.length ? { consults: runtime.consults } : {}),
    ...(runtime.consultedBy?.length ? { consultedBy: runtime.consultedBy } : {}),
    ...(runtime.reviewers?.length ? { reviewed: true } : {}),
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
      // A queue made before requests were stamped gains their column.
      if (!this.sql.exec('pragma table_info(wakes)').toArray().some((column) => column.name === 'request')) this.sql.exec('alter table wakes add column request text')
      this.sql.exec('create index if not exists wakes_state on wakes (state, at)')
      this.sql.exec('create table if not exists holds (task text primary key, thread text not null, operation text, state text not null, at integer not null)')
      this.sql.exec('create table if not exists budget_tasks (task text primary key, period text not null, kind text not null, open integer not null, at integer not null)')
      // Every thread it has run a session in: letting it go (§5.7) retires each.
      this.sql.exec('create table if not exists sessions (thread text primary key, at integer not null)')
      this.sql.exec('insert or ignore into sessions (thread, at) select distinct thread, max(at) from wakes group by thread')
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
    // A seat provisioned for the first time (a hire, §5.7) introduces itself: one turn, queued like any wake-up.
    if (runtime !== null && this.runtime === null && !this.ctx.storage.kv.get('introduced')) {
      this.ctx.storage.kv.put('introduced', new Date().toISOString())
      // Part of the request that hired it, when a proposal did: its introductions show under it.
      const request: RequestHint | null = runtime.request ? { id: runtime.request, via: 'label', reply: false } : null
      this.sql.exec("insert or ignore into wakes (id, thread, task, input, state, at, request) values ('intro', ?, null, ?, 'queued', ?, ?)", runtime.doc, JSON.stringify(introduction(runtime)), Date.now(), JSON.stringify(request))
      // Work made for it before it existed (a hire's, waiting on its proposal) went ready before its wake was set: it's taken up now.
      await this.#adopt(runtime)
    }
    if (!same) {
      if (runtime === null) {
        // Let go: the brief says so.
        if (this.runtime) await watch(this.env).letGo(this.runtime.key).catch(() => undefined)
        this.ctx.storage.kv.delete('runtime')
      }
      else {
        this.ctx.storage.kv.put('runtime', runtime)
        this.ctx.storage.kv.put('revision', revision)
        this.ctx.storage.kv.put('key', runtime.key)
      }
    }
    // Let go: its sessions and workspace are torn down (once), its run records kept.
    if (runtime === null) await this.#teardown()
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
    // The operator's own daily schedule in ops/briefs: the brief is written from the watchdog's facts, by code, as the operator.
    if (event.type === 'message.posted' && event.message?.schedule && event.message.channel === BRIEFS && this.runtime?.role === 'operator') {
      await this.#brief(this.runtime, event)
      return { queued: false, thread: threadOf(event) }
    }
    // The operator hears of a failed task or a lease run out from the watchdog, once, with the facts
    // (watch.ts), not also through its follow of the tasks it made.
    if (this.runtime?.role === 'operator' && context.wake.startsWith('seat.') && RAISED_BY_WATCHDOG.has(event.type)) return { queued: false, thread: threadOf(event) }
    // A plain mention wakes a seat only from a person (§5.5): seats reach each other through their
    // edges (a consult, an escalation, an assignment), so another seat's @mention alone wakes nothing.
    const fromSeat = event.message?.author?.kind === 'agent'
    const rules = context.rules.filter((rule) => !(fromSeat && /^mention(-\d+)?$/.test(rule)))
    if (rules.length === 0) return { queued: false, thread: threadOf(event) }
    context = { ...context, rules }
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
    const result = this.sql.exec('insert or ignore into wakes (id, thread, task, input, state, at, request) values (?, ?, ?, ?, ?, ?, ?)', id, thread, task, JSON.stringify(input), 'queued', Date.now(), answer && hold ? null : JSON.stringify(requestOf(event, context.rules)))
    if (result.rowsWritten > 0) await this.pump()
    return { queued: result.rowsWritten > 0, thread, ...(answer && hold ? { answer: answer.task } : {}) }
  }

  /**
   * A reviews edge (§4.5): before this seat completes a task, a review task for each of its
   * reviewers, in the same channel, and every open task that needs the reviewed one now needs the
   * reviews too, so work after it waits on them. As the app, the tasks' owner (a seat may only
   * change the needs of tasks it made). Once per task and reviewer: client IDs make a retry the same.
   */
  async review(task: string): Promise<{ reviews: string[]; waiting: string[] }> {
    const runtime = this.runtime
    if (!runtime?.reviewers?.length) return { reviews: [], waiting: [] }
    const app = bus()
    const { message } = await app.message(task, { limit: 1 })
    const first = String(message.text ?? '').split('\n')[0]!.slice(0, 200)
    const reviews: string[] = []
    for (const reviewer of runtime.reviewers) {
      const text = 'Review #' + task + ', which @' + runtime.handle + ' finished: ' + first + '\n\nRead it (and what it made), then complete this task if it holds, or reply here with what to change.'
      // Part of the reviewed work's request, as everything a seat makes for it.
      const request = message.labels?.[REQUEST]
      const made = await app.tasks.create({ channel: message.channel, text, id: 'review-' + task + '-' + reviewer, ...(reviewer === 'principal' ? {} : { for: 'worker:workbus-app+' + reviewer }), ...(request ? { labels: { [REQUEST]: request } } : {}) })
      const id = String(made.task?.id ?? made.message?.id)
      // The principal's review is held for them: in their inbox, kind review.
      if (reviewer === 'principal' && made.task?.state !== 'blocked') await app.tasks.block(id, 'A review of #' + task + ' for the principal', 'review').catch(() => undefined)
      reviews.push(id)
    }
    const waiting: string[] = []
    const { tasks } = await app.tasks.list({ needs: task, state: 'open', limit: 100 })
    for (const { message: dependent } of tasks as { message: { id: string; task: { needs: string[]; state: string } } }[]) {
      const needs = [...new Set([...dependent.task.needs, ...reviews])]
      if (needs.length === dependent.task.needs.length) continue
      await app.tasks.needs(dependent.id, needs)
      waiting.push(dependent.id)
    }
    return { reviews, waiting }
  }

  /**
   * Labels a message with its request, as the app: what a seat makes where it may post but not label
   * (a proposal in org/) gets its org.request this way (harness/board.ts).
   */
  async stamp(id: string, request: string): Promise<void> {
    await bus().label(id, { set: { [REQUEST]: request } })
  }

  /** An escalation to a seat (§4.3): held as the app, so the seat it's for (its task's maker) answers it, not only the principal. */
  async escalate(task: string, reason: string, kind?: string): Promise<unknown> {
    return bus().tasks.block(task, reason, kind)
  }

  /**
   * The watchdog raising something with the operator (watch.ts): one wake-up in the thread it's about,
   * once per id, with the facts. The operator decides: retry, reassign, or ask the principal.
   */
  async notice(notice: { id: string; thread: string; text: string }): Promise<{ queued: boolean }> {
    const text = [
      'The watchdog raised this: ' + notice.text,
      'Decide what it needs, in this thread: retry it (task_reopen, or leave a freed task ready for its seat), reassign it (task_assign), or ask the principal (mention them) if only they can decide. Say what you decided in one short reply. If it needs nothing, stop without posting.',
    ].join('\n')
    const result = this.sql.exec("insert or ignore into wakes (id, thread, task, input, state, at) values (?, ?, ?, ?, 'queued', ?)", 'notice:' + notice.id, notice.thread, notice.thread, JSON.stringify({ type: 'turn', parts: [{ type: 'text', text }] } satisfies Turn), Date.now())
    if (result.rowsWritten > 0) await this.pump()
    return { queued: result.rowsWritten > 0 }
  }

  /** The brief now, as its schedule would write it (POST /api/briefs): for the principal who wants one before 07:00. */
  async briefNow(): Promise<{ written: string | null }> {
    const runtime = this.runtime
    if (!runtime || runtime.role !== 'operator') return { written: null }
    const at = new Date().toISOString()
    await this.#brief(runtime, { cursor: 'now', type: 'message.posted', createdAt: at, message: null })
    return { written: BRIEFS + '/' + at.slice(0, 10) }
  }

  /** Writes the daily brief, ops/briefs/<date>, as the operator: the watchdog's facts, in its own words (watch.ts). */
  async #brief(runtime: SeatRuntime, event: Delivered): Promise<void> {
    const now = event.createdAt ? Date.parse(event.createdAt) : Date.now()
    const date = new Date(now).toISOString().slice(0, 10)
    try {
      const body = await (this.env.WATCH.getByName('bus') as unknown as { brief(until: number, date: string): Promise<string> }).brief(now, date)
      const board = seatBoard(bus(), runtime)
      // One brief a date: the slug keeps it so (a second write is refused, slug_taken). No client ID, so a brief deleted can be written again.
      await board.docs.create({ channel: BRIEFS, slug: date, body })
      if (event.message) await board.reply(String(event.message.re ?? event.message.id), { text: 'Today\'s brief: [[' + BRIEFS + '/' + date + ']]', id: 'brief-reply-' + date })
    } catch (error) {
      console.error('seat ' + runtime.key + ': the brief for ' + date + ' failed', error)
    }
  }

  /**
   * A seat let go (§5.7): every session it ran is retired (aborted, its container stopped, its
   * storage deleted), its workspace emptied, its queue dropped, and what it held for the principal
   * canceled with a note. Its run records (its totals) stay, and so does all it wrote on the board.
   * Once: a let-go seat let go again changes nothing.
   */
  async #teardown(): Promise<{ sessions: number } | null> {
    const key = this.ctx.storage.kv.get<string>('key')
    if (!key || this.ctx.storage.kv.get('tornDown')) return null
    const threads = new Set(this.sql.exec<{ thread: string }>('select thread from sessions union select thread from wakes union select thread from holds').toArray().map((row) => row.thread))
    let sessions = 0
    for (const thread of threads) {
      try {
        const session = (await getAgentByName(this.env.SESSION as never, sessionName(key, thread))) as unknown as { retire(): Promise<void> }
        await session.retire()
        sessions++
      } catch (error) {
        // Destroying a Durable Object can end the call before it answers: the storage is gone either way.
        if (!/destroy|reset|disconnected/i.test(String(error))) console.warn('seat ' + key + ': retiring its session in #' + thread, error)
        else sessions++
      }
    }
    await (this.env.WORKSPACE.getByName(key) as unknown as { reset(): Promise<void> }).reset().catch((error: unknown) => console.warn('seat ' + key + ': emptying its workspace', error))
    this.sql.exec("update wakes set state = 'dropped', error = 'let go' where state in ('queued', 'running', 'held')")
    const app = bus()
    const open = [
      ...this.sql.exec<{ task: string }>("select task from holds where state = 'held'").toArray().map((row) => row.task),
      ...this.sql.exec<{ task: string }>('select task from budget_tasks where open = 1').toArray().map((row) => row.task),
    ]
    for (const task of open) await app.tasks.cancel(task, 'The seat that held this, @' + key + ', was let go.').catch(() => undefined)
    this.sql.exec("update holds set state = 'closed' where state = 'held'")
    this.sql.exec('update budget_tasks set open = 0')
    this.ctx.storage.kv.put('tornDown', { at: new Date().toISOString(), sessions, threads: threads.size })
    await this.ctx.storage.deleteAlarm()
    return { sessions }
  }

  /** The tasks already ready for a seat that has just been provisioned: one wake-up each, as its assigned rule would have brought. */
  async #adopt(runtime: SeatRuntime): Promise<void> {
    try {
      const actor = 'worker:workbus-app+' + runtime.key
      const { tasks } = (await bus().tasks.list({ for: actor, state: 'ready', limit: 50 })) as { tasks: { message: any }[] }
      for (const { message } of tasks) {
        const event: Delivered = { cursor: 'adopt-' + message.id, type: 'task.ready', createdAt: new Date().toISOString(), message }
        const input: Turn = { type: 'turn', parts: [{ type: 'text', text: render(event, ['assigned'], String(message.id)) }] }
        this.sql.exec("insert or ignore into wakes (id, thread, task, input, state, at) values (?, ?, ?, ?, 'queued', ?)", 'adopt:' + message.id, String(message.id), String(message.id), JSON.stringify(input), Date.now() + 1)
      }
    } catch (error) {
      console.warn('seat ' + runtime.key + ': taking up its ready tasks', error)
    }
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
    // A run its Seat stopped for making no progress (#stalls) ends as that, however its session's wait came back.
    const stalled = row.error?.startsWith('aborted, stalled') ? row.error : null
    if (stalled) {
      error = stalled
      if (outcome) outcome = { ...outcome, status: 'unanswered', reason: stalled }
    }
    this.sql.exec('update wakes set state = ?, ended = ?, error = ? where id = ?', outcome === null || stalled ? 'failed' : 'done', now, error ?? outcome?.reason ?? null, row.id)
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
          // Part of the request whose work spent the budget: the newest that ran.
          const last = this.#one<{ request: string }>("select request from wakes where request is not null and request != 'null' and started is not null order by started desc limit 1")
          const request = last ? (JSON.parse(last.request) as RequestHint | null)?.id : undefined
          const made = await tasks.create({ channel: 'dm/' + runtime.key, text: words.text, id: 'budget-' + runtime.key + '-' + period + '-' + step.hold, ...(request ? { labels: { [REQUEST]: request } } : {}) })
          const task = String(made.task.id)
          await tasks.block(task, words.reason, 'budget').catch((error: unknown) => {
            // Made by an earlier try and held already: that's what this step wanted.
            if (!/already|task_blocked|blocked/.test(String(error))) throw error
          })
          this.sql.exec('insert or replace into budget_tasks (task, period, kind, open, at) values (?, ?, ?, 1, ?)', task, period, step.hold, now)
          // At the limit the operator hears too (§8.6), once a period, unless it's the operator's own.
          if (step.hold === 'limit' && runtime.key !== OPERATOR)
            await watch(this.env).raise({ kind: 'budget', ref: runtime.key + ':' + period, thread: runtime.doc, text: words.text + ' (Its budget task, #' + task + ', is held for the principal in dm/' + runtime.key + '.)' + ' Its wake-ups wait until the principal raises its budget or ' + monthName(period) + ' ends.' }).catch((error: unknown) => console.warn('seat ' + runtime.key + ': raising its budget', error))
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

  /** Its runs that ended at or after since, and what they cost: the brief's day (watch.ts). */
  async spentSince(since: string): Promise<{ runs: number; cost: number }> {
    const row = this.#one<{ runs: number; cost: number | null }>("select count(*) as runs, sum(cost) as cost from telemetry_runs where json_extract(record, '$.ended') >= ?", since)
    return { runs: row?.runs ?? 0, cost: row?.cost ?? 0 }
  }

  /** Its runs in some threads, oldest first: what a request cost (the app's request timeline). */
  async runsIn(threads: string[]): Promise<Run[]> {
    const wanted = [...new Set(threads)].slice(0, 200)
    if (wanted.length === 0) return []
    return this.sql
      .exec<{ record: string }>("select record from telemetry_runs where json_extract(record, '$.thread') in (" + wanted.map(() => '?').join(', ') + ') order by rowid', ...wanted)
      .toArray()
      .map((row) => JSON.parse(row.record) as Run)
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
    return { code: SEAT_CODE, retired: this.ctx.storage.kv.get('tornDown') ?? null, seat: runtime?.key ?? null, revision: this.ctx.storage.kv.get<number>('revision') ?? null, state: this.state(), runtime, queue, wakes, holds, spend: spend && { ...spend, budget: runtime!.budget.month }, runs, budget }
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
    // While anything runs, the alarm comes back to follow it, and to stop it once it's run past its limit.
    if (this.#one('select 1 as there from wakes where state in (\'running\', \'held\')')) next = Math.min(next ?? Infinity, Date.now() + Math.min(FOLLOW_MS, Number((this.env as { WATCHDOG_STALL_MS?: string }).WATCHDOG_STALL_MS ?? STALL_MS)))
    if (next !== null) {
      const armed = await this.ctx.storage.getAlarm()
      if (armed === null || armed > next) await this.ctx.storage.setAlarm(next)
    }
  }

  async #start(runtime: SeatRuntime, row: WakeRow): Promise<void> {
    this.sql.exec("update wakes set state = 'running', started = ?, attempts = attempts + 1 where id = ?", Date.now(), row.id)
    this.sql.exec('insert or ignore into sessions (thread, at) values (?, ?)', row.thread, Date.now())
    try {
      const session = await new PiHarnessAdapter(this.env.SESSION).open(seatRef(runtime), row.thread)
      const input = JSON.parse(row.input) as Input
      // An answer resumes its operation, whose request stands; a turn brings its own (or none: a schedule).
      const request = row.request === null || row.request === undefined ? undefined : (JSON.parse(row.request) as RequestHint | null)
      await session.submit(input, { operationId: row.id, ...(row.task ? { task: row.task } : {}), ...(request !== undefined ? { request } : {}) })
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

  /**
   * A session that makes no progress within its limit is stopped (§8.6): its operation aborted, a
   * word in its thread, and the operator told. A session parked on an approval isn't stalled.
   */
  async #stalls(runtime: SeatRuntime): Promise<void> {
    const limit = Number((this.env as { WATCHDOG_STALL_MS?: string }).WATCHDOG_STALL_MS ?? STALL_MS)
    const stalled = this.sql.exec<WakeRow>("select * from wakes where state = 'running' and started < ? and thread not in (select thread from wakes where state = 'held')", Date.now() - limit).toArray()
    for (const row of stalled) {
      const took = limit < 60_000 ? Math.round(limit / 1000) + ' seconds' : Math.round(limit / 60_000) + (Math.round(limit / 60_000) === 1 ? ' minute' : ' minutes')
      const why = 'aborted, stalled: no progress in ' + took
      // Marked first: whichever ends it (this, or its session's wait as the abort lands), the run is recorded as stopped.
      this.sql.exec('update wakes set error = ? where id = ?', why, row.id)
      try {
        const session = await new PiHarnessAdapter(this.env.SESSION).open(seatRef(runtime), row.thread)
        await session.abort(row.id)
      } catch (error) {
        console.warn('seat ' + runtime.key + ': aborting ' + row.id, error)
      }
      await this.ended(row.id, null, why)
      const said = 'I stopped this run: it made no progress in ' + took + '. @op has been told.'
      await seatBoard(bus(), runtime).reply(row.thread, { text: said, id: 'stalled-' + row.id.replace(/[^A-Za-z0-9_-]/g, '-') }).catch((error: unknown) => console.warn('seat ' + runtime.key + ': reporting a stall', error))
      if (runtime.key !== OPERATOR)
        await watch(this.env).raise({ kind: 'stalled', ref: row.id, thread: row.task ?? runtime.doc, text: runtime.name + ' (@' + runtime.handle + ')\'s run in #' + row.thread + ' made no progress in ' + took + ', so its Seat stopped it.' }).catch((error: unknown) => console.warn('seat ' + runtime.key + ': raising a stall', error))
    }
  }

  async alarm(): Promise<void> {
    const runtime = this.runtime
    if (runtime) await this.#stalls(runtime)
    if (runtime)
      for (const row of this.sql.exec<WakeRow>("select * from wakes where state in ('running', 'held')").toArray())
        if (!this.#following.has(row.id)) this.ctx.waitUntil(this.#follow(runtime, row.id, row.thread))
    // A new period starts its budget over: the limit task closes, and the queue runs.
    if (runtime) await this.#budget(runtime)
    await this.pump()
  }
}

// Tasks: a thread with a state. A task's ID is its root's; its state lives in the tasks table (what
// queues and filters read), each change is a task.* event in the board log, and each event keeps
// the task's view as that event left it (task_views), so a feed shows a task as it was then.
// Every write is one synchronous transaction: of claims that race, the Durable Object's input gate
// lets one decide at a time, so exactly one lands and the others see it claimed.
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'
import { badRequest, WorkbusError, conflict, forbidden, notFound } from '../errors.ts'
import { authorize, cursorOf, iso, ref, type Author, type MessageRow } from './core.ts'
import { TIMERS } from './ops.ts'
import { checkClientId, compile, matches, postMessage, refuseReserved, writeTerms, type Mentioned } from './messages.ts'
import { hooks, op, viewOf, viewOptions, type Ctx } from './ops.ts'
import { DDL } from './schema.ts'
import { json } from './sql.ts'

// The task's view after each of its events: what a feed shows, and the stored order of its needs.
DDL.push('create table if not exists task_views (root integer not null, seq integer not null, view text not null, primary key (root, seq)) strict, without rowid')

export const LEASE_DEFAULT_S = 900
export const LEASE_MIN_S = 30
export const LEASE_CAP_S = 3600
export const TASK_NEEDS_MAX = 20
export const TASK_BATCH_MAX = 100
export const TASK_KEY_MAX = 64
export const TASK_NOTE_MAX = 1000
export const FROM_MAX = 32
export const NEEDS_WALK_MAX = 500
export const EDITED_HOLD = 'edited'
const EDITED_REASON = 'its text was edited by someone who does not own the task'

export type TaskState = 'waiting' | 'ready' | 'claimed' | 'blocked' | 'completed' | 'failed' | 'canceled'
const OPEN: TaskState[] = ['waiting', 'ready', 'claimed', 'blocked']
const FINISHED: TaskState[] = ['completed', 'failed', 'canceled']

type Task = {
  root: number
  channel: string
  thread: string
  state: TaskState
  owner: string
  by: string
  for: string | null
  needs: number[]
  epoch: number
  claim: { actor: string; until: number; hash: string } | null
  blocked: { kind: string | null; reason: string } | null
  result: string | null
  reason: string | null
  created: number
}

type TaskRow = { root: number; channel: string; state: TaskState; owner: string; by_actor: string; for_actor: string | null; epoch: number; claim_actor: string | null; claim_until: number | null; claim_hash: string | null; hold_kind: string | null; hold_reason: string | null; result: string | null; reason: string | null; created: number }

export type TaskView = { state: TaskState; owner: string; by: string; for: string | null; needs: string[]; epoch: number; claim: { actor: string; until: string } | null; blocked: { kind: string | null; reason: string } | null; result: string | null; reason: string | null }

const viewOfTask = (task: Task): TaskView => ({
  state: task.state,
  owner: task.owner,
  by: task.by,
  for: task.for,
  needs: task.needs.map(ref),
  epoch: task.epoch,
  claim: task.claim ? { actor: task.claim.actor, until: iso(task.claim.until) } : null,
  blocked: task.blocked ? { kind: task.blocked.kind, reason: task.blocked.reason } : null,
  result: task.result,
  reason: task.reason,
})

// -- reading and writing a task ---------------------------------------------------------------

type Reader = Pick<Ctx, 'sql'>

function load(ctx: Reader, root: number): Task | null {
  const row = ctx.sql.one<TaskRow>('select * from tasks where root = ?', root)
  if (!row) return null
  const thread = ctx.sql.one<{ thread_key: string }>('select thread_key from messages where id = ?', root)?.thread_key ?? ref(root)
  const latest = ctx.sql.one<{ view: string }>('select view from task_views where root = ? order by seq desc limit 1', root)
  const needs = latest ? (JSON.parse(latest.view) as TaskView).needs.map(Number) : ctx.sql.all<{ needs: number }>('select needs from task_needs where task = ? order by needs', root).map((entry) => entry.needs)
  return {
    root: row.root,
    channel: row.channel,
    thread,
    state: row.state,
    owner: row.owner,
    by: row.by_actor,
    for: row.for_actor,
    needs,
    epoch: row.epoch,
    claim: row.claim_actor !== null && row.claim_until !== null && row.claim_hash !== null ? { actor: row.claim_actor, until: row.claim_until, hash: row.claim_hash } : null,
    blocked: row.state === 'blocked' ? { kind: row.hold_kind, reason: row.hold_reason ?? '' } : null,
    result: row.result,
    reason: row.reason,
    created: row.created,
  }
}

function persist(ctx: Reader, task: Task, needsChanged: boolean) {
  ctx.sql.run(
    'insert into tasks (root, channel, state, owner, by_actor, for_actor, epoch, claim_actor, claim_until, claim_hash, hold_kind, hold_reason, result, reason, created) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) on conflict (root) do update set state = excluded.state, for_actor = excluded.for_actor, epoch = excluded.epoch, claim_actor = excluded.claim_actor, claim_until = excluded.claim_until, claim_hash = excluded.claim_hash, hold_kind = excluded.hold_kind, hold_reason = excluded.hold_reason, result = excluded.result, reason = excluded.reason',
    task.root, task.channel, task.state, task.owner, task.by, task.for, task.epoch, task.claim?.actor ?? null, task.claim?.until ?? null, task.claim?.hash ?? null, task.blocked?.kind ?? null, task.blocked?.reason ?? null, task.result, task.reason, task.created,
  )
  if (!needsChanged) return
  ctx.sql.run('delete from task_needs where task = ?', task.root)
  for (const need of task.needs) ctx.sql.run('insert or ignore into task_needs (task, needs) values (?, ?)', task.root, need)
}

/** The root's index rows, with its task's state as board.task. */
function indexRoot(ctx: Ctx, root: number, state: TaskState | null) {
  const row = ctx.board.message(root)
  if (!row) return
  const labels = json<Record<string, string>>(row.labels, {})
  if (state && !row.deleted) labels['board.task'] = state
  writeTerms(ctx, { id: row.id, thread: row.thread, text: row.text, deleted: row.deleted, labels, attachments: json(row.attachments, []) })
}

/**
 * Appends one task event, after changing the task with change (the fold of that event): the
 * tables first, so the event's facets say what it changed, then the event, then the view it left.
 */
function apply(ctx: Ctx, task: Task, type: string, payload: Record<string, unknown>, change: (task: Task) => void, needsChanged = false): number {
  const before = ctx.board.facet(task.root)
  const seq = ctx.board.reserve()
  change(task)
  persist(ctx, task, needsChanged)
  ctx.sql.run('update messages set version = ? where id = ?', seq, task.root)
  ctx.board.append(type, { id: task.root, thread: task.thread, ...payload }, { at: ctx.now, message: task.root, thread: task.root, before, seq })
  ctx.sql.run('insert into task_views (root, seq, view) values (?, ?, ?)', task.root, seq, JSON.stringify(viewOfTask(task)))
  indexRoot(ctx, task.root, task.state)
  return seq
}

/** A task's view as it is now, or as its events had left it at a position. */
hooks.taskView = (ctx, root, at) => {
  const found = at === undefined
    ? ctx.sql.one<{ view: string }>('select view from task_views where root = ? order by seq desc limit 1', root)
    : ctx.sql.one<{ view: string }>('select view from task_views where root = ? and seq <= ? order by seq desc limit 1', root, at)
  return found ? (JSON.parse(found.view) as TaskView) : undefined
}

// -- rules --------------------------------------------------------------------------------------

const sha256 = (value: string) => createHash('sha256').update(value, 'utf8').digest('hex')
const sameHash = (a: string, b: string) => a.length === b.length && timingSafeEqual(Buffer.from(a, 'hex'), Buffer.from(b, 'hex'))
// 32 random bytes: 43 base64url characters, the shape a claim token takes on the wire.
const newToken = () => randomBytes(32).toString('base64url')

const live = (task: Task, now: number) => task.state === 'claimed' && task.claim !== null && task.claim.until > now
/** The state a claim sees: a claim whose lease ran out is over, whether or not task.expired landed. */
const stateNow = (task: Task, now: number): TaskState => (task.state === 'claimed' && !live(task, now) ? 'ready' : task.state)

function leaseMs(lease: number | undefined): number {
  if (lease === undefined) return LEASE_DEFAULT_S * 1000
  if (!(lease >= LEASE_MIN_S && lease <= LEASE_CAP_S)) throw badRequest('lease: a lease is ' + LEASE_MIN_S + ' to ' + LEASE_CAP_S + ' seconds')
  return Math.round(lease * 1000)
}

function checkNote(field: 'result' | 'reason', note: string | undefined) {
  if (note !== undefined && note.length > TASK_NOTE_MAX) throw badRequest(field + ": a task's " + field + ' is at most 1,000 characters')
}

const escapeRe = (value: string) => value.replace(/[.*+?^\${}()|[\]\\]/g, '\\$&')
function checkFor(owner: string, value: string | null | undefined) {
  if (value === undefined || value === null) return
  if (!new RegExp('^' + escapeRe(owner) + '\\+[a-z][a-z0-9-]{0,31}$').test(value)) throw badRequest("for: a task is assigned to one of its owner's profiles, " + owner + '+<profile>, got ' + value)
}

const distinct = <T,>(values: readonly T[]) => [...new Set(values)]
function checkNeedsCount(needs: readonly unknown[] | undefined, field = 'needs') {
  if (needs && distinct(needs).length > TASK_NEEDS_MAX) throw badRequest(field + ': a task waits for at most ' + TASK_NEEDS_MAX + ' tasks')
}

const wroteAs = (author: { actor: string; principal: string }, task: Task) => task.owner === author.principal && (author.actor === author.principal || task.by === author.actor)

/** Whether the caller changes this task as its owner: manage in its channel, or its owner as it made it, who may still post or label there. */
function owns(ctx: Ctx, task: Task) {
  if (ctx.access.can('manage', task.channel)) return
  if (wroteAs(ctx.author, task) && (ctx.access.can('post', task.channel) || ctx.access.can('label', task.channel))) return
  throw forbidden('#' + task.root + " is someone else's task: its owner as itself, the profile that made it, or manage in " + task.channel + ', changes it', 'task_not_owned')
}

/** A task the caller can read, by its path ID: 404 when it can't see the message, or when it isn't a task. */
function taskOf(ctx: Ctx, id: string): { row: MessageRow; task: Task } {
  const row = ctx.board.readable(id, ctx.access)
  const task = row.re === null ? load(ctx, row.id) : null
  if (!task) throw notFound('#' + id + " isn't a task", 'not_a_task')
  return { row, task }
}

const pending = (ctx: Reader, needs: number[]) => {
  if (needs.length === 0) return []
  const done = new Set(ctx.sql.all<{ root: number }>("select root from tasks where state = 'completed' and root in (select value from json_each(?))", ctx.sql.list(needs)).map((row) => row.root))
  return needs.filter((need) => !done.has(need))
}
const refs = (ids: number[]) => ids.map((id) => '#' + id).join(', ')

/** Prerequisites as given, resolved against what the caller can see: each an open, failed, or completed task. */
function resolveNeeds(ctx: Ctx, given: readonly string[], self: number | null): number[] {
  const out: number[] = []
  for (const value of distinct(given)) {
    const invalid = (message: string) => new WorkbusError(400, 'invalid_needs', 'needs: ' + message)
    if (!/^[1-9]\d{0,15}$/.test(value)) throw invalid('#' + value + " isn't a task")
    const id = Number(value)
    if (self !== null && id === self) throw invalid('#' + value + " is the task itself: it can't wait for itself")
    const row = ctx.board.message(id)
    const task = row && row.re === null ? ctx.sql.one<{ state: TaskState }>('select state from tasks where root = ?', id) : null
    if (!row || !task || !ctx.access.readable(row.channel)) throw invalid('#' + value + " isn't a task")
    if (task.state === 'canceled') throw invalid('#' + value + ' was canceled: it can never complete')
    if (!out.includes(id)) out.push(id)
  }
  return out
}

/** Refuses prerequisites that wait, through any chain, for the task: walked in SQL, at most NEEDS_WALK_MAX tasks. */
function checkCycle(ctx: Ctx, task: number, added: number[]) {
  if (added.length === 0) return
  const walk = (seeds: number[]) =>
    ctx.sql.all<{ id: number }>(
      "with recursive walk(id) as (select value from json_each(?) union select n.needs from walk w join tasks t on t.root = w.id join task_needs n on n.task = w.id where t.state != 'completed') select id from walk limit ?",
      ctx.sql.list(seeds), NEEDS_WALK_MAX + 1,
    ).map((row) => row.id)
  const reached = walk(added)
  if (reached.includes(task)) {
    const through = added.find((seed) => walk([seed]).includes(task)) ?? added[0]!
    throw new WorkbusError(400, 'invalid_needs', 'needs: #' + through + ' waits for #' + task + ' already: they would wait for each other')
  }
  if (reached.length > NEEDS_WALK_MAX) throw new WorkbusError(400, 'invalid_needs', 'needs: #' + added[0] + ' has more than ' + NEEDS_WALK_MAX + ' tasks behind it and the others: too many to check that none waits for #' + task)
}

// -- the events, as the fold applies them ----------------------------------------------------------

function create(ctx: Ctx, root: MessageRow, needs: number[], assignee: string | null): Task {
  const task: Task = { root: root.id, channel: root.channel, thread: root.thread_key, state: 'waiting', owner: ctx.caller.principal.id, by: ctx.author.actor, for: assignee, needs: [], epoch: 0, claim: null, blocked: null, result: null, reason: null, created: ctx.now }
  apply(ctx, task, 'task.created', { needs, for: assignee, by: ctx.author }, (t) => {
    t.needs = needs
    t.state = needs.length > 0 ? 'waiting' : 'ready'
  }, true)
  return task
}

function ready(ctx: Ctx, task: Task) {
  apply(ctx, task, 'task.ready', {}, (t) => void (t.state = 'ready'))
}

/** Readies the task if it waits and everything it needs has completed. */
function readyIfDone(ctx: Ctx, task: Task) {
  if (task.state === 'waiting' && task.needs.length > 0 && pending(ctx, task.needs).length === 0) ready(ctx, task)
}

function expire(ctx: Ctx, task: Task) {
  apply(ctx, task, 'task.expired', { epoch: task.epoch }, (t) => {
    t.state = 'ready'
    t.claim = null
  })
  ctx.clearTimer('lease', String(task.root))
}

type Claim = { epoch: number; token: string; until: string }

function claim(ctx: Ctx, task: Task, lease: number, token: string | undefined): Claim {
  if (task.state === 'claimed') expire(ctx, task)
  const given = token ?? newToken()
  const until = ctx.now + lease
  const epoch = task.epoch + 1
  const hash = sha256(given)
  apply(ctx, task, 'task.claimed', { epoch, until: iso(until), token: hash, by: ctx.author }, (t) => {
    t.state = 'claimed'
    t.epoch = epoch
    t.claim = { actor: ctx.author.actor, until, hash }
  })
  armLease(ctx, task.root, until)
  return { epoch, token: given, until: iso(until) }
}

/** Why a task can't be claimed by this caller now, as the error to throw; null when it can. */
function unclaimable(ctx: Ctx, task: Task): WorkbusError | null {
  const state = stateNow(task, ctx.now)
  if (state === 'waiting') return conflict('task_waiting', '#' + task.root + ' waits for ' + refs(pending(ctx, task.needs)))
  if (state === 'blocked') return conflict('task_blocked', '#' + task.root + ' is held for a person: ' + (task.blocked?.reason ?? ''))
  if (FINISHED.includes(state)) return conflict('task_finished', '#' + task.root + ' is ' + state)
  if (task.for !== null && !(task.for === ctx.actor.id && task.owner === ctx.caller.principal.id)) return conflict('task_assigned', '#' + task.root + ' is assigned to ' + task.for)
  if (state === 'claimed') return conflict('task_claimed', '#' + task.root + ' is claimed until ' + iso(task.claim!.until))
  return null
}

const claimLost = (task: Task) => conflict('claim_lost', 'this claim on #' + task.root + ' is over: claim it again')
/** A claim's own write lands only while that claim holds the task: its epoch, its token, its lease. */
function fence(ctx: Ctx, task: Task, proof: { epoch: number; token: string }) {
  if (!(live(task, ctx.now) && task.epoch === proof.epoch && sameHash(task.claim!.hash, sha256(proof.token)))) throw claimLost(task)
}

function armLease(ctx: Ctx, root: number, until: number) {
  ctx.timer('lease', String(root), until)
}

/** The lease timer: a claim still held at that epoch whose lease has ended gives the task back. */
function leaseTimer(ctx: Ctx, key: string) {
  const task = load(ctx, Number(key))
  if (!task || task.state !== 'claimed' || !task.claim) return
  if (task.claim.until > ctx.now + 1000) return ctx.timer('lease', key, task.claim.until)
  expire(ctx, task)
}
TIMERS.lease = leaseTimer

const answer = (ctx: Ctx, task: Task) => ({ task: viewOf(ctx, task.root)! })

// -- edits and deletes of a task's root -----------------------------------------------------------

hooks.rootEdited = (ctx, root) => {
  const task = load(ctx, root)
  if (!task) return
  const edit = ctx.sql.one<{ payload: string }>("select payload from events where seq = ? and type = 'message.edited' and message = ?", ctx.board.head, root)
  const payload = edit ? (JSON.parse(edit.payload) as { by: Author; from: string | null }) : { by: ctx.author, from: null }
  const holds = ['waiting', 'ready', 'claimed'].includes(task.state) && (payload.from !== null || !wroteAs(payload.by, task))
  if (holds) {
    apply(ctx, task, 'task.blocked', { kind: EDITED_HOLD, reason: EDITED_REASON, by: payload.by }, (t) => {
      t.state = 'blocked'
      t.claim = null
      t.blocked = { kind: EDITED_HOLD, reason: EDITED_REASON }
    })
    ctx.clearTimer('lease', String(root))
  } else indexRoot(ctx, root, task.state)
}

hooks.rootDeleted = (ctx, root) => {
  const task = load(ctx, root)
  if (!task || task.state === 'completed' || task.state === 'canceled') return
  apply(ctx, task, 'task.canceled', { reason: 'deleted', by: ctx.author }, (t) => {
    t.state = 'canceled'
    t.claim = null
    t.blocked = null
    t.reason = 'deleted'
  })
  ctx.clearTimer('lease', String(root))
}

// -- making tasks -------------------------------------------------------------------------------

type CreateTask = {
  channel?: string
  re?: string
  text?: string
  labels?: Record<string, string>
  noSync?: boolean
  attachments?: string[]
  id?: string
  needs?: string[]
  for?: string | null
  claim?: boolean
  lease?: number
  token?: string
}

op('createTask', (ctx, body: CreateTask) => {
  checkNeedsCount(body.needs)
  const lease = body.claim ? leaseMs(body.lease) : 0
  const assignee = body.for ?? null
  if (body.re !== undefined) {
    const target = ctx.board.readable(body.re, ctx.access)
    authorize(ctx.access, 'label', target.channel)
    checkFor(ctx.caller.principal.id, assignee)
    if (target.re !== null) throw badRequest('#' + target.id + ' is a reply: a task is a thread, so name its root, #' + target.re)
    if (target.deleted) throw badRequest('message was deleted', 'message_deleted')
    if (load(ctx, target.id)) throw conflict('already_a_task', '#' + target.id + ' is a task already')
    const needs = resolveNeeds(ctx, body.needs ?? [], target.id)
    if (body.claim) {
      const waits = pending(ctx, needs)
      if (waits.length) throw conflict('task_waiting', '#' + target.id + ' would wait for ' + refs(waits) + ": it wasn't made a task")
      if (assignee !== null && assignee !== ctx.actor.id) throw conflict('task_assigned', '#' + target.id + ' would be assigned to ' + assignee + ": it wasn't made a task")
    }
    ctx.board.seen(ctx.actor, ctx.now)
    const task = create(ctx, target, needs, assignee)
    readyIfDone(ctx, task)
    const made = body.claim ? claim(ctx, task, lease, body.token) : null
    return { ...answer(ctx, task), ...(made ? { claim: made } : {}) }
  }
  const channel = body.channel!
  refuseReserved(Object.keys(body.labels ?? {}))
  authorize(ctx.access, 'post', channel)
  if (Object.keys(body.labels ?? {}).length) authorize(ctx.access, 'label', channel)
  if (body.id !== undefined) checkClientId(ctx, body.id)
  checkFor(ctx.caller.principal.id, assignee)
  if (body.claim) authorize(ctx.access, 'label', channel)
  const posted = postMessage(ctx, { channel, text: body.text ?? '', ...(body.labels ? { labels: body.labels } : {}), ...(body.noSync ? { noSync: true } : {}), ...(body.attachments ? { attachments: body.attachments } : {}), ...(body.id !== undefined ? { id: body.id } : {}) })
  if (posted.replayed) {
    const task = posted.row.re === null ? load(ctx, posted.row.id) : null
    if (!task) throw conflict('duplicate_id', 'that id was already used for a different write')
    // A retry gets the claim back only when the live claim is the one this request's token made.
    const again = body.claim && body.token !== undefined && live(task, ctx.now) && sameHash(task.claim!.hash, sha256(body.token))
    return { ...answer(ctx, task), ...(again ? { claim: { epoch: task.epoch, token: body.token!, until: iso(task.claim!.until) } } : {}) }
  }
  const needs = resolveNeeds(ctx, body.needs ?? [], null)
  if (body.claim) {
    const waits = pending(ctx, needs)
    if (waits.length) throw conflict('task_waiting', 'the task would wait for ' + refs(waits) + ': nothing was made')
    if (assignee !== null && assignee !== ctx.actor.id) throw conflict('task_assigned', 'the task would be assigned to ' + assignee + ': nothing was made')
  }
  const task = create(ctx, posted.row, needs, assignee)
  readyIfDone(ctx, task)
  const made = body.claim ? claim(ctx, task, lease, body.token) : null
  return { ...answer(ctx, task), ...(made ? { claim: made } : {}), ...(posted.mentions ? { mentions: posted.mentions } : {}) }
})

// -- batches ------------------------------------------------------------------------------------

type BatchNeed = string | { key: string }
type BatchTask = { key?: string; text: string; labels?: Record<string, string>; noSync?: boolean; attachments?: string[]; needs?: BatchNeed[]; for?: string | null }
type CreateTasks = { channel: string; tasks: BatchTask[]; id?: string; request?: string; tooLarge?: number }
type StoredBatch = { roots: number[]; actor: string; principal: string; profile: string | null; channel: string; blind: boolean }

const batchTooLarge = (count: number) => new WorkbusError(400, 'batch_too_large', 'a batch makes ' + TASK_BATCH_MAX + ' tasks at most, and this one has ' + count + ': send it in parts')

/** The digest of a batch request as it was given: the same channel and the same tasks, in order. */
export function batchRequest(body: { channel: string; tasks: BatchTask[] }): string {
  const sorted = (labels: Record<string, string>) => Object.entries(labels).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
  const tasks = body.tasks.map((t) => [t.key ?? null, t.text, sorted(t.labels ?? {}), t.noSync ?? false, t.attachments ?? [], t.needs ?? [], t.for ?? null])
  return sha256(JSON.stringify([body.channel, tasks])).slice(0, 32)
}

/** What a batch's keys say, from the batch alone: each task's batch-mates, or the problem. */
function batchPlan(tasks: BatchTask[]): number[][] {
  const invalid = (problem: string) => new WorkbusError(400, 'invalid_needs', 'needs: ' + problem)
  const byKey = new Map<string, number>()
  tasks.forEach((task, i) => {
    if (task.key === undefined) return
    if (byKey.has(task.key)) throw invalid('two tasks of the batch have the key ' + JSON.stringify(task.key))
    byKey.set(task.key, i)
  })
  const mates = tasks.map((task, i) => {
    const out: number[] = []
    for (const need of task.needs ?? []) {
      if (typeof need === 'string') continue
      const at = byKey.get(need.key)
      if (at === undefined) throw invalid('no task of the batch has the key ' + JSON.stringify(need.key))
      if (at === i) throw invalid('the task with the key ' + JSON.stringify(need.key) + ' waits for itself')
      if (!out.includes(at)) out.push(at)
    }
    return out
  })
  const color = tasks.map(() => 0)
  const stack: number[] = []
  const visit = (i: number) => {
    color[i] = 1
    stack.push(i)
    for (const next of mates[i]!) {
      if (color[next] === 1) {
        const cycle = stack.slice(stack.indexOf(next))
        throw invalid('the tasks with the keys ' + cycle.map((at) => String(JSON.stringify(tasks[at]!.key))).join(', ') + ' wait for each other')
      }
      if (color[next] === 0) visit(next)
    }
    stack.pop()
    color[i] = 2
  }
  tasks.forEach((_, i) => color[i] === 0 && visit(i))
  return mates
}

function storedBatch(ctx: Ctx, id: string): { batch: StoredBatch; digest: string | null } | null {
  const row = ctx.sql.one<{ result: string; digest: string | null }>('select result, digest from idempotency where key = ?', 'batch:' + id)
  return row ? { batch: JSON.parse(row.result) as StoredBatch, digest: row.digest } : null
}
const batchMine = (ctx: Ctx, batch: StoredBatch) => batch.actor === ctx.author.actor && batch.principal === ctx.author.principal && (batch.profile ?? null) === ctx.author.profile
const batchViews = (ctx: Ctx, batch: StoredBatch) => batch.roots.map((root) => viewOf(ctx, root)).filter((view) => view !== null)

op('createTasks', (ctx, body: CreateTasks) => {
  if (body.tooLarge !== undefined) throw batchTooLarge(body.tooLarge)
  if (body.tasks.length > TASK_BATCH_MAX) throw batchTooLarge(body.tasks.length)
  body.tasks.forEach((task, i) => {
    refuseReserved(Object.keys(task.labels ?? {}))
    if (task.key !== undefined && task.key.length > TASK_KEY_MAX) throw badRequest('tasks.' + i + ".key: a task's key is at most " + TASK_KEY_MAX + ' characters')
    checkNeedsCount((task.needs ?? []).map((need) => (typeof need === 'string' ? 'id ' + need : 'key ' + need.key)), 'tasks.' + i + '.needs')
    if (distinct(task.attachments ?? []).length > 10) throw badRequest('tasks.' + i + '.attachments: a message carries at most 10')
  })
  const { channel } = body
  authorize(ctx.access, 'post', channel)
  if (body.tasks.some((task) => Object.keys(task.labels ?? {}).length)) authorize(ctx.access, 'label', channel)
  if (body.id !== undefined) checkClientId(ctx, body.id)
  for (const task of body.tasks) checkFor(ctx.caller.principal.id, task.for)
  const mates = batchPlan(body.tasks)
  const request = body.request ?? batchRequest(body)
  if (body.id !== undefined) {
    const landed = storedBatch(ctx, body.id)
    if (landed) {
      if (!batchMine(ctx, landed.batch) || (landed.digest !== null && landed.digest !== request)) throw conflict('duplicate_id', 'that id was already used for a different write')
      return { tasks: batchViews(ctx, landed.batch) }
    }
  }
  const outside = body.tasks.map((task) => resolveNeeds(ctx, (task.needs ?? []).filter((need): need is string => typeof need === 'string'), null))
  const readies = body.tasks.map((_, i) => mates[i]!.length === 0 && outside[i]!.length > 0 && pending(ctx, outside[i]!).length === 0)
  // Each task's events are its post, task.created, and task.ready when it's ready at once: so each
  // root's ID, a batch-mate's after it included, is known before anything is written.
  ctx.board.seen(ctx.actor, ctx.now)
  const roots: number[] = []
  let at = ctx.board.head
  for (let i = 0; i < body.tasks.length; i++) {
    roots.push(at + 1)
    at += 2 + (readies[i] ? 1 : 0)
  }
  const mentions: Mentioned[] = []
  const written = new Set<string>()
  let blind = false
  body.tasks.forEach((spec, i) => {
    const batch = body.id !== undefined ? { event: { batch: { id: body.id, index: i, key: spec.key ?? null } } } : {}
    const posted = postMessage(ctx, { channel, text: spec.text, ...(spec.labels ? { labels: spec.labels } : {}), ...(spec.noSync ? { noSync: true } : {}), ...(spec.attachments ? { attachments: spec.attachments } : {}) }, batch)
    if (posted.row.id !== roots[i]) throw new WorkbusError(500, 'internal', 'a batch root landed at #' + posted.row.id + ', not #' + roots[i])
    if (posted.row.blind) blind = true
    for (const mention of posted.mentions ?? []) if (!written.has(mention.written)) written.add(mention.written), mentions.push(mention)
    const needs = distinct([...outside[i]!, ...mates[i]!.map((mate) => roots[mate]!)])
    const task = create(ctx, posted.row, needs, spec.for ?? null)
    if (readies[i]) ready(ctx, task)
  })
  if (body.id !== undefined) {
    const stored: StoredBatch = { roots, actor: ctx.author.actor, principal: ctx.author.principal, profile: ctx.author.profile, channel, blind }
    ctx.sql.run('insert into idempotency (key, result, digest, at) values (?, ?, ?, ?)', 'batch:' + body.id, JSON.stringify(stored), request, ctx.now)
  }
  return { tasks: roots.map((root) => viewOf(ctx, root)!), ...(mentions.length ? { mentions } : {}) }
})

op('createdTasks', (ctx, query: { id: string; request?: string }) => {
  const landed = storedBatch(ctx, query.id)
  if (!landed || !batchMine(ctx, landed.batch) || !(ctx.access.readable(landed.batch.channel) || landed.batch.blind)) throw notFound('no batch of yours has id ' + query.id, 'batch_not_found')
  if (query.request !== undefined && landed.digest !== null && landed.digest !== query.request) throw conflict('duplicate_id', 'that id was already used for a different write')
  return { tasks: batchViews(ctx, landed.batch) }
}, { read: true })

// -- listing ------------------------------------------------------------------------------------

type TasksQuery = { channel?: string; state?: 'open' | 'all' | TaskState; label?: string | string[]; by?: string; owner?: string; for?: string; needs?: string; after?: string; limit?: number; latest?: boolean }

/** The IDs a name covers: itself, the actors with that handle, and a person's principal. */
function named(ctx: Ctx, value: string): string[] {
  const out = new Set([value])
  for (const actor of ctx.sql.all<{ id: string; principal: string; kind: string }>('select id, principal, kind from actors where handle_lc = ?', value.toLowerCase())) {
    out.add(actor.id)
    if (actor.kind === 'person') out.add(actor.principal)
  }
  return [...out]
}

const summary = (ctx: Ctx, root: number) => {
  const options = viewOptions(ctx)
  const thread = ctx.sql.one<{ replies: number; last: number }>('select replies, last from threads where root = ?', root)
  const last = thread && thread.last !== root ? ctx.board.message(thread.last) : null
  return { message: ctx.board.view(ctx.board.message(root)!, options), replies: thread?.replies ?? 0, last: last ? ctx.board.view(last, options) : null }
}

op('tasks', (ctx, query: TasksQuery) => {
  const limit = query.limit ?? 50
  const head = ref(ctx.board.head)
  const where: string[] = ['coalesce(m.deleted, c.root_deleted) = 0']
  const args: unknown[] = []
  const state = query.state ?? 'open'
  if (state === 'open') where.push("t.state in ('waiting', 'ready', 'claimed', 'blocked')")
  else if (state === 'ready') where.push("(t.state = 'ready' or (t.state = 'claimed' and t.claim_until <= ?))"), args.push(ctx.now)
  else if (state === 'claimed') where.push("t.state = 'claimed' and t.claim_until > ?"), args.push(ctx.now)
  else if (state !== 'all') where.push('t.state = ?'), args.push(state)
  if (query.channel !== undefined) {
    if (query.channel.endsWith('/')) {
      const path = query.channel.slice(0, -1)
      where.push('(t.channel = ? or substr(t.channel, 1, ?) = ?)'), args.push(path, path.length + 1, path + '/')
    } else where.push('t.channel = ?'), args.push(query.channel)
  }
  if (query.needs !== undefined) {
    if (!/^[1-9]\d{0,15}$/.test(query.needs)) return { tasks: [], cursor: head }
    where.push('t.root in (select task from task_needs where needs = ?)'), args.push(Number(query.needs))
  }
  if (query.owner !== undefined) where.push('t.owner in (select value from json_each(?))'), args.push(ctx.sql.list(named(ctx, query.owner)))
  if (query.for !== undefined) where.push('t.for_actor in (select value from json_each(?))'), args.push(ctx.sql.list(named(ctx, query.for)))
  if (query.after !== undefined) where.push('t.root > ?'), args.push(cursorOf(query.after))
  const filters = query.label !== undefined || query.by !== undefined ? compile(ctx, { ...(query.label !== undefined ? { label: query.label } : {}), ...(query.by !== undefined ? { by: query.by } : {}) }) : null
  const found: { root: number; active: number }[] = []
  const PAGE = 500
  for (let from = 0; ; ) {
    const rows = ctx.sql.all<{ root: number; channel: string; active: number }>(
      "select t.root, t.channel, coalesce(l.created_at, m.created_at, c.active) as active from tasks t left join messages m on m.id = t.root left join cold_threads c on c.root = t.root and c.state = 'cold' left join threads th on th.root = t.root left join messages l on l.id = th.last where " + where.join(' and ') + ' and t.root > ? order by t.root limit ?',
      ...args, from, PAGE,
    )
    for (const row of rows) {
      if (!ctx.access.readable(row.channel)) continue
      if (filters && !matches(filters, ctx.board.facet(row.root))) continue
      found.push({ root: row.root, active: row.active })
      if (!query.latest && found.length === limit) break
    }
    if (rows.length < PAGE || (!query.latest && found.length === limit)) break
    from = rows.at(-1)!.root
  }
  if (query.latest) {
    const kept = found.map((entry, i) => ({ ...entry, i })).sort((a, b) => a.active - b.active || a.i - b.i).slice(-limit)
    return { tasks: kept.map((entry) => summary(ctx, entry.root)), cursor: head }
  }
  return { tasks: found.map((entry) => summary(ctx, entry.root)), cursor: found.length === limit ? ref(found.at(-1)!.root) : head }
}, { read: true })

// -- claims -------------------------------------------------------------------------------------

op('claimTask', (ctx, body: { id: string; lease?: number; token?: string }) => {
  const lease = leaseMs(body.lease)
  const { task } = taskOf(ctx, body.id)
  authorize(ctx.access, 'label', task.channel)
  if (body.token !== undefined && live(task, ctx.now) && sameHash(task.claim!.hash, sha256(body.token)))
    return { ...answer(ctx, task), claim: { epoch: task.epoch, token: body.token, until: iso(task.claim!.until) } }
  const refused = unclaimable(ctx, task)
  if (refused) throw refused
  ctx.board.seen(ctx.actor, ctx.now)
  const made = claim(ctx, task, lease, body.token)
  return { ...answer(ctx, task), claim: made }
})

type ClaimReady = { channel: string; label?: Record<string, string>; from?: string[]; lease?: number; wait?: number; token?: string }

op('claimReadyTask', (ctx, body: ClaimReady) => {
  const lease = leaseMs(body.lease)
  const from = body.from ?? []
  if (from.length > FROM_MAX) throw badRequest('from: a claim takes tasks from at most ' + FROM_MAX + ' owners')
  for (const value of from) if (!/^[^\s:]+:\S+$/.test(value)) throw new WorkbusError(400, 'invalid_from', 'from: ' + value + ' is a handle, which several can share: name the owner by ID')
  const subtree = body.channel.endsWith('/')
  const path = subtree ? body.channel.slice(0, -1) : body.channel
  if (!subtree) authorize(ctx.access, 'label', path)
  else if (!ctx.access.anywhere('label')) throw forbidden("this token can't label anywhere, so it can't claim a task")
  const owners = distinct([ctx.caller.principal.id, ...from])
  const range = subtree ? '(t.channel = ? or substr(t.channel, 1, ?) = ?)' : 't.channel = ?'
  const rangeArgs = subtree ? [path, path.length + 1, path + '/'] : [path]
  const fits = (root: number, channel: string): Task | null => {
    if (!ctx.access.can('label', channel)) return null
    const row = ctx.board.message(root)
    if (!row || row.deleted) return null
    const labels = json<Record<string, string>>(row.labels, {})
    for (const [key, value] of Object.entries(body.label ?? {})) if (labels[key] !== value) return null
    const task = load(ctx, root)
    return task && stateNow(task, ctx.now) === 'ready' ? task : null
  }
  const first = (extra: string, extraArgs: unknown[]): Task | null => {
    for (let after = 0; ; ) {
      const rows = ctx.sql.all<{ root: number; channel: string }>("select t.root, t.channel from tasks t where t.state in ('ready', 'claimed') and " + range + ' and ' + extra + ' and t.root > ? order by t.root limit 200', ...rangeArgs, ...extraArgs, after)
      for (const row of rows) {
        const task = fits(row.root, row.channel)
        if (task) return task
      }
      if (rows.length < 200) return null
      after = rows.at(-1)!.root
    }
  }
  const task = first('t.for_actor = ? and t.owner = ?', [ctx.actor.id, ctx.caller.principal.id]) ?? first('t.for_actor is null and t.owner in (select value from json_each(?))', [ctx.sql.list(owners)])
  if (!task) return { task: null }
  ctx.board.seen(ctx.actor, ctx.now)
  const made = claim(ctx, task, lease, body.token)
  return { ...answer(ctx, task), claim: made }
})

type Proof = { id: string; epoch: number; token: string }

op('renewTask', (ctx, body: Proof & { lease?: number }) => {
  const lease = leaseMs(body.lease)
  const { task } = taskOf(ctx, body.id)
  fence(ctx, task, body)
  ctx.board.seen(ctx.actor, ctx.now)
  const until = ctx.now + lease
  apply(ctx, task, 'task.renewed', { epoch: task.epoch, until: iso(until), by: ctx.author }, (t) => void (t.claim = { ...t.claim!, until }))
  armLease(ctx, task.root, until)
  return { ...answer(ctx, task), until: iso(until) }
})

op('releaseTask', (ctx, body: Proof) => {
  const { task } = taskOf(ctx, body.id)
  fence(ctx, task, body)
  ctx.board.seen(ctx.actor, ctx.now)
  apply(ctx, task, 'task.released', { epoch: task.epoch, by: ctx.author }, (t) => {
    t.state = 'ready'
    t.claim = null
  })
  ctx.clearTimer('lease', String(task.root))
  return answer(ctx, task)
})

op('completeTask', (ctx, body: Proof & { result?: string }) => {
  checkNote('result', body.result)
  const { task } = taskOf(ctx, body.id)
  fence(ctx, task, body)
  // A part whose task this is (a doc's proposal) does its work first, or refuses the completion.
  hooks.taskCompleting(ctx, task.root)
  ctx.board.seen(ctx.actor, ctx.now)
  const result = body.result ?? null
  apply(ctx, task, 'task.completed', { epoch: task.epoch, result, by: ctx.author }, (t) => {
    t.state = 'completed'
    t.claim = null
    t.result = result
  })
  ctx.clearTimer('lease', String(task.root))
  // Its dependents, wherever they are and whoever may read them, are ready in this same write.
  const waiting = ctx.sql.all<{ task: number }>("select n.task from task_needs n join tasks t on t.root = n.task where n.needs = ? and t.state = 'waiting' order by n.task", task.root)
  for (const { task: root } of waiting) {
    const dependent = load(ctx, root)
    if (dependent) readyIfDone(ctx, dependent)
  }
  return answer(ctx, task)
})

op('failTask', (ctx, body: Proof & { reason: string }) => {
  checkNote('reason', body.reason)
  const { task } = taskOf(ctx, body.id)
  fence(ctx, task, body)
  ctx.board.seen(ctx.actor, ctx.now)
  apply(ctx, task, 'task.failed', { epoch: task.epoch, reason: body.reason, by: ctx.author }, (t) => {
    t.state = 'failed'
    t.claim = null
    t.reason = body.reason
  })
  ctx.clearTimer('lease', String(task.root))
  return answer(ctx, task)
})

// -- the owner's writes -------------------------------------------------------------------------

op('blockTask', (ctx, body: { id: string; reason: string; kind?: string; epoch?: number; token?: string }) => {
  checkNote('reason', body.reason)
  if (body.kind !== undefined && !/^[a-z0-9][a-z0-9_.-]{0,63}$/.test(body.kind)) throw badRequest('kind: a kind is up to 64 lowercase letters, numbers, and _.-')
  const { task } = taskOf(ctx, body.id)
  if (body.epoch !== undefined && body.token !== undefined) fence(ctx, task, { epoch: body.epoch, token: body.token })
  else {
    owns(ctx, task)
    if (live(task, ctx.now)) throw conflict('task_claimed', '#' + task.root + ' is claimed until ' + iso(task.claim!.until) + ': only its claim holds it')
    if (task.state === 'blocked') throw conflict('task_blocked', '#' + task.root + ' is held already: ' + (task.blocked?.reason ?? ''))
    if (FINISHED.includes(task.state)) throw conflict('task_finished', '#' + task.root + ' is ' + task.state)
  }
  ctx.board.seen(ctx.actor, ctx.now)
  const kind = body.kind ?? null
  apply(ctx, task, 'task.blocked', { kind, reason: body.reason, by: ctx.author }, (t) => {
    t.state = 'blocked'
    t.claim = null
    t.blocked = { kind, reason: body.reason }
  })
  ctx.clearTimer('lease', String(task.root))
  return answer(ctx, task)
})

op('unblockTask', (ctx, body: { id: string }) => {
  const { task } = taskOf(ctx, body.id)
  owns(ctx, task)
  if (FINISHED.includes(task.state)) throw conflict('task_finished', '#' + task.root + ' is ' + task.state)
  if (task.state !== 'blocked') return answer(ctx, task)
  ctx.board.seen(ctx.actor, ctx.now)
  apply(ctx, task, 'task.unblocked', { by: ctx.author }, (t) => {
    t.state = t.needs.length > 0 ? 'waiting' : 'ready'
    t.blocked = null
  })
  readyIfDone(ctx, task)
  return answer(ctx, task)
})

op('reopenTask', (ctx, body: { id: string }) => {
  const { task } = taskOf(ctx, body.id)
  owns(ctx, task)
  if (task.state === 'completed' || task.state === 'canceled') throw conflict('task_finished', '#' + task.root + ' is ' + task.state)
  if (task.state !== 'failed') return answer(ctx, task)
  ctx.board.seen(ctx.actor, ctx.now)
  apply(ctx, task, 'task.reopened', { by: ctx.author }, (t) => {
    t.state = 'ready'
    t.reason = null
  })
  return answer(ctx, task)
})

op('assignTask', (ctx, body: { id: string; for: string | null }) => {
  const { task } = taskOf(ctx, body.id)
  owns(ctx, task)
  checkFor(task.owner, body.for)
  if (FINISHED.includes(task.state)) throw conflict('task_finished', '#' + task.root + ' is ' + task.state)
  if (task.for === body.for) return answer(ctx, task)
  ctx.board.seen(ctx.actor, ctx.now)
  apply(ctx, task, 'task.assigned', { for: body.for, by: ctx.author }, (t) => void (t.for = body.for))
  return answer(ctx, task)
})

op('setTaskNeeds', (ctx, body: { id: string; needs: string[] }) => {
  checkNeedsCount(body.needs)
  const { task } = taskOf(ctx, body.id)
  owns(ctx, task)
  if (FINISHED.includes(task.state)) throw conflict('task_finished', '#' + task.root + ' is ' + task.state)
  if (live(task, ctx.now)) throw conflict('task_claimed', '#' + task.root + ' is claimed until ' + iso(task.claim!.until) + ': what it needs changes once no one holds it')
  const needs = resolveNeeds(ctx, body.needs, task.root)
  const same = needs.length === task.needs.length && needs.every((need) => task.needs.includes(need))
  if (same) return answer(ctx, task)
  checkCycle(ctx, task.root, needs.filter((need) => !task.needs.includes(need)))
  ctx.board.seen(ctx.actor, ctx.now)
  if (task.state === 'claimed') expire(ctx, task)
  apply(ctx, task, 'task.needs_changed', { needs, by: ctx.author }, (t) => {
    t.needs = needs
    if (t.state !== 'blocked') t.state = needs.length > 0 ? 'waiting' : 'ready'
  }, true)
  readyIfDone(ctx, task)
  return answer(ctx, task)
})

op('cancelTask', (ctx, body: { id: string; reason: string }) => {
  checkNote('reason', body.reason)
  const { task } = taskOf(ctx, body.id)
  owns(ctx, task)
  if (task.state === 'completed' || task.state === 'canceled') throw conflict('task_finished', '#' + task.root + ' is ' + task.state)
  ctx.board.seen(ctx.actor, ctx.now)
  apply(ctx, task, 'task.canceled', { reason: body.reason, by: ctx.author }, (t) => {
    t.state = 'canceled'
    t.claim = null
    t.blocked = null
    t.reason = body.reason
  })
  ctx.clearTimer('lease', String(task.root))
  return answer(ctx, task)
})

export { OPEN as OPEN_TASK_STATES }

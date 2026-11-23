// The tasks routes: a thread with a state, claimed under a lease, fenced by its epoch and token.
import { z } from 'zod'
import { AttachmentId, ChannelPath, ClientId, LabelFilter, Labels, NewLabels, QueryBool, QueryInt, Ref, storable } from './fields.ts'
import { route } from './routes.ts'

const TASK_BATCH_MAX = 100
const TASK_STATES = ['waiting', 'ready', 'claimed', 'blocked', 'completed', 'failed', 'canceled'] as const

const ActorId = z.string().min(1).max(256)
const Lease = z.number()
const ClaimToken = z.string().regex(/^[A-Za-z0-9_-]{43}$/, 'a claim token is 32 bytes in base64url: 43 characters')
const ChannelOrSubtree = z.string().max(2049).regex(/^[a-z0-9][a-z0-9_-]*(?:\/[a-z0-9][a-z0-9_-]*)*\/?$/, 'name a channel, or a channel and its subtree (work/)')
const SentTaskNote = z.string().refine((text) => text.trim().length > 0, 'it is empty').refine(storable, 'it has a NUL character or a lone surrogate')
const SentTaskHoldKind = z.string().regex(/^[a-z0-9][a-z0-9_.-]*$/, 'a kind is lowercase letters, numbers, and _.-')
const Claimed = { epoch: z.number().int().positive(), token: z.string().min(1).max(128) }
// A claim's proof, or none: without one, it's the task's owner ending a claim it doesn't hold.
const MaybeClaimed = { epoch: Claimed.epoch.optional(), token: Claimed.token.optional() }
const bothOrNeither = (body: { epoch?: number; token?: string }) => (body.epoch === undefined) === (body.token === undefined)
const BOTH_OR_NEITHER = { message: 'a claim is its \u0060epoch\u0060 and its \u0060token\u0060: pass both, or neither' }

const CreateTaskBody = z
  .object({
    channel: ChannelPath.optional(),
    re: Ref.optional(),
    text: z.string().optional(),
    labels: NewLabels.optional(),
    noSync: z.boolean().optional(),
    attachments: z.array(AttachmentId).optional(),
    id: ClientId.optional(),
    needs: z.array(Ref).optional(),
    for: ActorId.nullable().optional(),
    claim: z.boolean().optional(),
    lease: Lease.optional(),
    token: ClaimToken.optional(),
  })
  .refine((body) => (body.channel === undefined) !== (body.re === undefined), { message: "a task needs \u0060channel\u0060 and \u0060text\u0060 for a new thread, or \u0060re\u0060 for a thread that's there" })
  .refine((body) => body.channel === undefined || (body.text ?? '').trim().length > 0 || (body.attachments?.length ?? 0) > 0, { path: ['text'], message: 'message text is empty' })
  .refine((body) => body.text === undefined || storable(body.text), { path: ['text'], message: 'message text has a NUL character or a lone surrogate' })
  .refine((body) => body.re === undefined || [body.text, body.labels, body.noSync, body.attachments, body.id].every((value) => value === undefined), {
    message: "\u0060text\u0060, \u0060labels\u0060, \u0060noSync\u0060, \u0060attachments\u0060, and \u0060id\u0060 are a new thread's: \u0060re\u0060 makes a task of a thread as it is",
  })
  .refine((body) => body.lease === undefined || body.claim === true, { path: ['lease'], message: '\u0060lease\u0060 goes with \u0060claim\u0060' })
  .refine((body) => body.token === undefined || body.claim === true, { path: ['token'], message: '\u0060token\u0060 goes with \u0060claim\u0060' })

const BatchNeed = z.union([Ref, z.strictObject({ key: z.string() })])
const BatchTask = z
  .object({
    key: z.string().min(1).refine(storable, 'key has a NUL character or a lone surrogate').optional(),
    text: z.string(),
    labels: NewLabels.optional(),
    noSync: z.boolean().optional(),
    attachments: z.array(AttachmentId).optional(),
    needs: z.array(BatchNeed).optional(),
    for: ActorId.nullable().optional(),
  })
  .refine((task) => task.text.trim().length > 0 || (task.attachments?.length ?? 0) > 0, { path: ['text'], message: 'message text is empty' })
  .refine((task) => storable(task.text), { path: ['text'], message: 'message text has a NUL character or a lone surrogate' })
const BatchShape = z.object({ channel: ChannelPath, tasks: z.array(BatchTask).min(1), id: ClientId.optional(), request: z.string().min(1).max(64).optional() })
// A batch over the limit is refused as too large before anything else of it is read.
const CreateTasksBody = z.unknown().transform((body, ctx) => {
  const tasks = body && typeof body === 'object' ? (body as { tasks?: unknown }).tasks : undefined
  if (Array.isArray(tasks) && tasks.length > TASK_BATCH_MAX) return { tooLarge: tasks.length } as unknown as z.infer<typeof BatchShape>
  const parsed = BatchShape.safeParse(body)
  if (!parsed.success) {
    for (const issue of parsed.error.issues) ctx.addIssue(issue as any)
    return z.NEVER
  }
  return parsed.data
})

const TasksQuery = z
  .object({
    channel: z.string().optional(),
    state: z.enum(['open', 'all', ...TASK_STATES]).optional(),
    label: z.union([LabelFilter, z.array(LabelFilter)]).optional(),
    by: z.string().optional(),
    owner: z.string().optional(),
    for: z.string().optional(),
    needs: Ref.optional(),
    after: Ref.optional(),
    limit: QueryInt(1, 500).optional(),
    latest: QueryBool.optional(),
  })
  .refine((query) => !(query.latest && query.after !== undefined), { path: ['latest'], message: '\u0060latest\u0060 reads every task to find the last active: it takes no \u0060after\u0060' })

const ClaimReadyTaskBody = z.object({
  channel: ChannelOrSubtree,
  label: Labels.optional(),
  from: z.array(z.string().min(1).max(256)).optional(),
  lease: Lease.optional(),
  wait: z.number().min(0).max(300).optional(),
  token: ClaimToken.optional(),
})

const BlockTaskBody = z
  .object({ reason: SentTaskNote, kind: SentTaskHoldKind.optional(), epoch: Claimed.epoch.optional(), token: Claimed.token.optional() })
  .refine((body) => (body.epoch === undefined) === (body.token === undefined), { message: 'a claim is its \u0060epoch\u0060 and its \u0060token\u0060: pass both, or neither' })
  .refine((body) => body.kind !== 'edited', { path: ['kind'], message: "\u0060edited\u0060 is the board's own kind, for a task whose root someone else edited: name another" })

route({ name: 'tasks', method: 'GET', path: '/tasks', query: TasksQuery })
route({ name: 'createTask', method: 'POST', path: '/tasks', body: CreateTaskBody, status: 201 })
route({ name: 'createTasks', method: 'POST', path: '/tasks/batch', body: CreateTasksBody, status: 201 })
route({ name: 'createdTasks', method: 'GET', path: '/tasks/batch/:id', query: z.object({ request: z.string().min(1).max(64).optional() }) })
route({ name: 'claimReadyTask', method: 'POST', path: '/tasks/claim', body: ClaimReadyTaskBody })
route({ name: 'claimTask', method: 'POST', path: '/tasks/:id/claim', body: z.object({ lease: Lease.optional(), token: ClaimToken.optional() }), optionalBody: true })
route({ name: 'renewTask', method: 'POST', path: '/tasks/:id/renew', body: z.object({ ...Claimed, lease: Lease.optional() }) })
route({ name: 'releaseTask', method: 'POST', path: '/tasks/:id/release', body: z.object(MaybeClaimed).refine(bothOrNeither, BOTH_OR_NEITHER), optionalBody: true })
route({ name: 'completeTask', method: 'POST', path: '/tasks/:id/complete', body: z.object({ ...MaybeClaimed, result: SentTaskNote.optional() }).refine(bothOrNeither, BOTH_OR_NEITHER), optionalBody: true })
route({ name: 'failTask', method: 'POST', path: '/tasks/:id/fail', body: z.object({ ...MaybeClaimed, reason: SentTaskNote }).refine(bothOrNeither, BOTH_OR_NEITHER) })
route({ name: 'blockTask', method: 'POST', path: '/tasks/:id/block', body: BlockTaskBody })
// An answer to a hold: approved or declined, with a note for whoever held it. Either way it's given back.
const UnblockTaskBody = z
  .object({ decision: z.enum(['approved', 'declined']).optional(), note: SentTaskNote.optional() })
  .refine((body) => body.note === undefined || body.decision !== undefined, { path: ['note'], message: 'a note goes with a \u0060decision\u0060, approved or declined' })
route({ name: 'unblockTask', method: 'POST', path: '/tasks/:id/unblock', body: UnblockTaskBody, optionalBody: true })
route({ name: 'reopenTask', method: 'POST', path: '/tasks/:id/reopen', body: z.unknown().transform(() => ({})), optionalBody: true })
route({ name: 'assignTask', method: 'POST', path: '/tasks/:id/assign', body: z.object({ for: ActorId.nullable() }) })
route({ name: 'setTaskNeeds', method: 'POST', path: '/tasks/:id/needs', body: z.object({ needs: z.array(Ref) }) })
route({ name: 'cancelTask', method: 'POST', path: '/tasks/:id/cancel', body: z.object({ reason: SentTaskNote }) })

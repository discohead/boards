// What the app knows about a task (packages/workbus/src/ledger/tasks.ts): its states in the order
// a list groups them, who it's for, and which writes apply to it now, for the caller. The task
// lists, My work, the inbox, the thread pane's Status face, and ⌘K all read it from here, so each
// shows the same states and offers the same actions.
import type { Message, TaskFacet } from '@/data'

export type TaskState = 'waiting' | 'ready' | 'claimed' | 'blocked' | 'completed' | 'failed' | 'canceled'

/** The order a list groups by, as Linear's: what's held for a person first, then in progress, then to do. */
export const STATES: readonly TaskState[] = ['blocked', 'claimed', 'ready', 'waiting', 'failed', 'completed', 'canceled']
export const OPEN: readonly TaskState[] = ['waiting', 'ready', 'claimed', 'blocked']
export const FINISHED: readonly TaskState[] = ['completed', 'failed', 'canceled']

export const STATE_LABEL: Record<TaskState, string> = {
  blocked: 'Held',
  claimed: 'Claimed',
  ready: 'Ready',
  waiting: 'Waiting',
  failed: 'Failed',
  completed: 'Done',
  canceled: 'Canceled',
}

/** The kinds a held task names (design/workbus.md §6.1); "edited" is the board's own. Any other kind shows as itself. */
export const HOLD_LABEL: Record<string, string> = {
  decision: 'Decision',
  approval: 'Approval',
  review: 'Review',
  budget: 'Budget',
  edited: 'Edited by someone else',
}

export type Task = Message & { task: TaskFacet }
export const isTask = (message: Message): message is Task => !!message.task && !message.deleted

export const stateOf = (task: Task) => task.task.state as TaskState
export const isOpen = (task: Task) => OPEN.includes(stateOf(task))

/** A held task's kind and reason, or null. */
export const holdOf = (task: Task): { kind: string | null; reason: string } | null =>
  stateOf(task) === 'blocked' ? ((task.task.blocked as { kind: string | null; reason: string } | null) ?? { kind: null, reason: '' }) : null
export const holdLabel = (kind: string | null) => (kind ? (HOLD_LABEL[kind] ?? kind) : 'Held')

/** The doc a task proposes a change to (board.doc.proposal names its ID), or null. */
export const proposalOf = (task: Message) => task.labels['board.doc.proposal'] ?? null

/** Who works it: its claim's actor while claimed, else whom it's assigned to, else no one. */
export const assigneeOf = (task: Task) => task.task.claim?.actor ?? task.task.for ?? null

/** An actor's profiles are <actor>+<profile>: a task for one of them is the actor's too. */
export const isOrIsProfileOf = (actor: string | null, me: string) => actor !== null && (actor === me || actor.startsWith(me + '+'))

/** My work: a task claimed by me, or for me (or one of my profiles). */
export const isMine = (task: Task, me: string) => isOrIsProfileOf(task.task.claim?.actor ?? null, me) || isOrIsProfileOf(task.task.for, me)

/** Labels a list shows: the board's own (board.*) are what the columns already say. */
export const shownLabels = (labels: Record<string, string>) => Object.entries(labels).filter(([key]) => !key.startsWith('board.'))

export type TaskAction = 'claim' | 'release' | 'complete' | 'fail' | 'block' | 'unblock' | 'reopen' | 'assign' | 'cancel'

/**
 * The writes that apply to a task now, for me, as the board decides them. The owner's writes
 * (block, unblock, reopen, assign, cancel) need its owner, or manage in its channel: `manages`
 * says whether I do. Complete and fail need a claim: when I don't hold one, the action claims first.
 */
export function actionsFor(task: Task, me: string, manages: boolean): TaskAction[] {
  const state = stateOf(task)
  const owner = manages || task.task.owner === me
  const mineClaim = task.task.claim?.actor === me
  const free = task.task.for === null || task.task.for === me
  const out: TaskAction[] = []
  if (state === 'ready' && free) out.push('claim', 'complete')
  if (state === 'claimed' && mineClaim) out.push('complete', 'release', 'fail')
  if (state === 'blocked' && owner) out.push('unblock')
  if ((state === 'ready' || state === 'waiting') && owner) out.push('block')
  if (state === 'failed' && owner) out.push('reopen')
  if (owner && !FINISHED.includes(state)) out.push('assign', 'cancel')
  return out
}

export const ACTION_LABEL: Record<TaskAction, string> = {
  claim: 'Claim',
  release: 'Release',
  complete: 'Complete',
  fail: 'Fail',
  block: 'Hold',
  unblock: 'Unblock',
  reopen: 'Reopen',
  assign: 'Assign',
  cancel: 'Cancel',
}

/** Whether a permission summary (/me's can: pattern to permissions) lets me do `what` in a channel. */
export function can(summary: Record<string, string[]> | null | undefined, what: string, channel: string) {
  if (!summary) return false
  for (const [pattern, perms] of Object.entries(summary)) {
    const has = perms.includes(what) || perms.includes('manage') || perms.includes('all')
    if (!has) continue
    if (pattern === '*' || pattern === channel) return true
    if (pattern.endsWith('/') && (channel === pattern.slice(0, -1) || channel.startsWith(pattern))) return true
  }
  return false
}

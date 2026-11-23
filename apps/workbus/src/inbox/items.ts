// The inbox's items (design/workbus.md §6.1), one per thread, from three queries:
//   what reaches the principal: threads with replies or mentions it hasn't read (read state; a root
//     that mentions it counts on its own thread);
//   tasks held for it (state blocked), each with its kind;
//   proposals waiting on it: open tasks labeled board.doc.proposal in channels it may edit.
// An item leaves when what put it there is answered: read (marked done, or replied to), unblocked,
// or the proposal applied or dropped.
import type { Message } from '@/data'
import type { Unread } from '@/data/unread'
import { can, holdOf, isOpen, proposalOf, stateOf, type Task } from '../task/model.ts'

export type Reason =
  | { kind: 'reply'; unread: number; mentions: number; latest: Message | null }
  | { kind: 'held'; hold: string | null; reason: string }
  | { kind: 'proposal'; doc: string }

export type InboxItem = { thread: string; channel: string; root: Message | null; task: Task | null; reasons: Reason[]; at: number }

/** Each thread's newest message by someone else, among the messages in memory. */
export function newestTheirs(messages: Iterable<Message>, me: string) {
  const newest = new Map<string, Message>()
  for (const message of messages) {
    if (message.by.actor === me || message.pending || message.deleted) continue
    const thread = message.re ?? message.id
    const had = newest.get(thread)
    if (!had || Number(message.id) > Number(had.id)) newest.set(thread, message)
  }
  return newest
}

export function inboxItems(input: { unread: Unread[]; tasks: Task[]; messages: Map<string, Message>; me: string; can: Record<string, string[]> | undefined }): InboxItem[] {
  const { unread, tasks, messages, me } = input
  const items = new Map<string, InboxItem>()
  const item = (thread: string, channel: string) => {
    let found = items.get(thread)
    if (!found) items.set(thread, (found = { thread, channel, root: messages.get(thread) ?? null, task: null, reasons: [], at: 0 }))
    return found
  }
  const theirs = newestTheirs(messages.values(), me)

  for (const row of unread) {
    if (row.kind !== 'thread' || !row.thread || (row.unread <= 0 && row.mentions <= 0)) continue
    const latest = theirs.get(row.thread) ?? null
    const one = item(row.thread, row.channel)
    one.reasons.push({ kind: 'reply', unread: row.unread, mentions: row.mentions, latest })
    one.at = Math.max(one.at, Number(latest?.id ?? row.read ?? row.thread))
  }

  for (const task of tasks) {
    const hold = holdOf(task)
    const doc = proposalOf(task)
    if (hold) {
      const one = item(task.id, task.channel)
      one.task = task
      one.root ??= task
      one.reasons.push({ kind: 'held', hold: hold.kind, reason: hold.reason })
      one.at = Math.max(one.at, task.version)
    } else if (doc && isOpen(task) && stateOf(task) !== 'blocked' && can(input.can, 'edit', task.channel)) {
      const one = item(task.id, task.channel)
      one.task = task
      one.root ??= task
      one.reasons.push({ kind: 'proposal', doc })
      one.at = Math.max(one.at, task.version)
    }
  }
  for (const one of items.values()) if (!one.task) one.task = (tasks.find((task) => task.id === one.thread) as Task | undefined) ?? null
  return [...items.values()].sort((a, b) => b.at - a.at)
}

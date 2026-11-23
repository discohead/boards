// The inbox's items (design/workbus.md §6.1), one per thread, from three queries:
//   what reaches the principal: threads with replies or mentions it hasn't read (read state), and
//     roots that mention it that its channel's count still holds;
//   tasks held for it (state blocked), each with its kind;
//   proposals waiting on it: open tasks labeled board.doc.proposal in channels it may edit.
// An item leaves when what put it there is answered: read (marked done, or replied to), unblocked,
// or the proposal applied or dropped.
import type { Message } from '@/data'
import { can, holdOf, isOpen, proposalOf, stateOf, type Task } from '../task/model.ts'
import type { ReachState } from './reach.ts'

export type Reason =
  | { kind: 'reply'; unread: number; mentions: number; latest: Message | null }
  | { kind: 'mention'; latest: Message }
  | { kind: 'held'; hold: string | null; reason: string }
  | { kind: 'proposal'; doc: string }

export type InboxItem = { thread: string; channel: string; root: Message | null; task: Task | null; reasons: Reason[]; at: number }

export function inboxItems(input: { reach: ReachState; tasks: Task[]; messages: Map<string, Message>; me: string; can: Record<string, string[]> | undefined }): InboxItem[] {
  const { reach, tasks, messages, me } = input
  const items = new Map<string, InboxItem>()
  const item = (thread: string, channel: string) => {
    let found = items.get(thread)
    if (!found) items.set(thread, (found = { thread, channel, root: messages.get(thread) ?? null, task: null, reasons: [], at: 0 }))
    return found
  }
  const latestIn = (thread: string) => {
    let latest: Message | null = null
    for (const message of reach.reached) if ((message.re ?? message.id) === thread && message.by.actor !== me) latest = message
    return latest
  }

  for (const row of reach.threads.values()) {
    if (row.unread <= 0 && row.mentions <= 0) continue
    const latest = latestIn(row.thread)
    const one = item(row.thread, row.channel)
    one.reasons.push({ kind: 'reply', unread: row.unread, mentions: row.mentions, latest })
    one.at = Math.max(one.at, Number(latest?.id ?? row.read))
  }

  // Roots that mention me count on their channel, not on a thread, until the board counts them on
  // their thread too: the channel's mentions beyond its threads' are those roots, newest first.
  const threadMentions = new Map<string, number>()
  for (const row of reach.threads.values()) threadMentions.set(row.channel, (threadMentions.get(row.channel) ?? 0) + row.mentions)
  for (const channel of reach.channels.values()) {
    let extra = channel.mentions - (threadMentions.get(channel.channel) ?? 0)
    if (extra <= 0) continue
    const read = Number(channel.read ?? 0)
    const roots = reach.reached.filter((message) => message.re === null && message.channel === channel.channel && Number(message.id) > read && message.by.actor !== me && message.text.includes('@[' + me + ']')).reverse()
    for (const root of roots) {
      if (extra-- <= 0) break
      const one = item(root.id, root.channel)
      if (!one.reasons.some((reason) => reason.kind === 'reply')) one.reasons.push({ kind: 'mention', latest: root })
      one.at = Math.max(one.at, Number(root.id))
    }
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

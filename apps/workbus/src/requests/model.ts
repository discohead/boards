// A request (the principal's message that started some work) and everything it caused, across
// channels, from the org.request label the seats stamp on what they make (the plan doc, the handoff,
// tasks, proposals, hires, holds, replies): the board's events carrying it, in time order, each in
// plain words with its state now and a link; and the runs the seats made in its threads, with cost.
import type { Message } from '@/data'
import { describe } from '@/task/proposal'
import { holdLabel, proposalOf } from '@/task/model'

export const REQUEST_LABEL = 'org.request'
/** The request a message belongs to, or is: its org.request label. */
export const requestOf = (message: Pick<Message, 'labels'> | null | undefined) => message?.labels?.[REQUEST_LABEL] ?? null

export type BoardEvent = { cursor: string; type: string; createdAt: string; payload: Record<string, any>; message?: Message & { doc?: { path: string; title?: string } }; actor?: { id: string; handle: string; name: string; kind: string } }

export type EntryKind = 'asked' | 'reply' | 'task' | 'proposal' | 'doc' | 'claimed' | 'completed' | 'failed' | 'held' | 'answered' | 'canceled' | 'lapsed' | 'assigned' | 'applied'
export type Entry = { cursor: string; at: string; kind: EntryKind; actor: string | null; text: string; thread: string; channel: string }

const firstLine = (text: string) => (text.split('\n').find((line) => line.trim()) ?? '').replace(/^#+\s*/, '').trim()
const short = (text: string, n = 120) => (text.length > n ? text.slice(0, n - 1) + '…' : text)

/** One event as a line of the timeline, or null for what doesn't say anything to the principal (labels, renewals). */
export function entryOf(event: BoardEvent, name: (actor: string) => string): Entry | null {
  const message = event.message
  const who = event.actor?.id ?? event.payload?.by?.actor ?? message?.by.actor ?? null
  const id = String(event.payload?.id ?? message?.id ?? '')
  const thread = message ? (message.re ?? message.id) : id
  const channel = message?.channel ?? ''
  const at = { cursor: event.cursor, at: event.createdAt, actor: who, thread, channel }
  const whoName = who ? name(who) : 'The board'
  const ref = '#' + id
  switch (event.type) {
    case 'message.posted': {
      if (!message) return null
      // A task's or a doc's root says itself through task.created and doc.created.
      if (message.re === null && (message.task || message.doc || event.payload?.task)) return null
      if (message.re === null) return { ...at, kind: 'reply', text: whoName + ' posted in ' + channel + ': ' + short(firstLine(message.text)) }
      return { ...at, kind: 'reply', text: whoName + ' replied in ' + channel + ': ' + short(firstLine(message.text)) }
    }
    case 'task.created': {
      if (message && proposalOf(message)) {
        const proposal = describe(message)
        return { ...at, kind: 'proposal', text: whoName + ' proposed: ' + (proposal?.title ?? firstLine(message.text)) }
      }
      const assignee = event.payload?.for ? ' for ' + name(String(event.payload.for)) : ''
      return { ...at, kind: 'task', text: whoName + ' made a task in ' + channel + assignee + ': ' + short(firstLine(message?.text ?? '')) }
    }
    case 'task.claimed':
      return { ...at, kind: 'claimed', text: whoName + ' took ' + ref }
    case 'task.completed':
      if (message && proposalOf(message)) return { ...at, kind: 'applied', text: whoName + ' applied ' + ref + ': ' + (describe(message)?.title ?? 'the proposal') }
      return { ...at, kind: 'completed', text: whoName + ' completed ' + ref + (event.payload?.result ? ': ' + short(String(event.payload.result)) : '') }
    case 'task.failed':
      return { ...at, kind: 'failed', text: whoName + ' failed ' + ref + (event.payload?.reason ? ': ' + short(String(event.payload.reason)) : '') }
    case 'task.blocked':
      return { ...at, kind: 'held', text: ref + ' held for you (' + holdLabel(event.payload?.kind ?? null).toLowerCase() + '): ' + short(String(event.payload?.reason ?? '')) }
    case 'task.unblocked':
      return { ...at, kind: 'answered', text: whoName + ' ' + (event.payload?.decision ?? 'unblocked') + ' ' + ref + (event.payload?.note ? ': ' + short(String(event.payload.note)) : '') }
    case 'task.canceled':
      return { ...at, kind: 'canceled', text: ref + (message && proposalOf(message) ? ' declined' : ' canceled') + (event.payload?.reason ? ': ' + short(String(event.payload.reason)) : '') }
    case 'task.expired':
      return { ...at, kind: 'lapsed', text: ref + "'s claim lapsed; it's ready again" }
    case 'task.assigned':
      return { ...at, kind: 'assigned', text: whoName + ' assigned ' + ref + ' to ' + (event.payload?.for ? name(String(event.payload.for)) : 'anyone') }
    case 'doc.created':
      return { ...at, kind: 'doc', text: whoName + ' wrote ' + (message?.doc?.path ?? event.payload?.path ?? 'a doc') }
    case 'doc.edited':
      return { ...at, kind: 'doc', text: whoName + ' edited ' + (message?.doc?.path ?? event.payload?.path ?? 'a doc') }
    default:
      return null
  }
}

/** What a request came to, now: its threads' tasks by state, its docs, its proposals, its open holds. */
export function summaryOf(threads: Message[]) {
  const tasks = threads.filter((one) => one.task && !proposalOf(one))
  const proposals = threads.filter((one) => one.task && proposalOf(one))
  const state = (one: Message) => String(one.task?.state ?? '')
  return {
    tasks: { all: tasks.length, done: tasks.filter((one) => state(one) === 'completed').length, open: tasks.filter((one) => ['ready', 'waiting', 'claimed'].includes(state(one))).length, held: tasks.filter((one) => state(one) === 'blocked').length },
    proposals: { all: proposals.length, applied: proposals.filter((one) => state(one) === 'completed').length, open: proposals.filter((one) => ['ready', 'waiting', 'claimed', 'blocked'].includes(state(one))).length },
    docs: threads.filter((one) => (one as Message & { doc?: unknown }).doc).length,
  }
}

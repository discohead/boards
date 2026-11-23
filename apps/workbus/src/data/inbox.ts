// What reached the principal (design/workbus.md §6.1): mentions, and what's new in threads and doc
// discussions it follows, read from GET /events?for=me. Each event's message is merged into
// messages, as an opened channel's are, with each thread's root, so an inbox item has its title.
// The messages trim lets loose messages go past MESSAGES_KEPT, so the inbox reads again on mount.
import type { BusCollections } from './index.ts'
import type { BusRuntime } from './runtime.ts'
import type { BoardEvent, Message } from './types.ts'

/** How many of the newest events that reached me the inbox reads. */
export const INBOX_EVENTS = 100

export function inboxReads(runtime: BusRuntime, c: BusCollections) {
  /** The messages that reached me, newest last, with their threads' roots in messages too. */
  const openInbox = async (): Promise<Message[]> => {
    const { client } = runtime
    const page = await client.get<{ events: BoardEvent[]; cursor: string }>('/events?for=me&last=' + INBOX_EVENTS)
    const reached = new Map<string, Message>()
    for (const event of page.events) if (event.message && event.type === 'message.posted') reached.set(event.message.id, event.message)
    const list = [...reached.values()].sort((a, b) => Number(a.id) - Number(b.id))
    c.messages.utils.rows.merge(list, (row) => row.version)
    const missing = [...new Set(list.map((message) => message.re ?? message.id))].filter((id) => !c.messages.has(id))
    const roots = await Promise.all(missing.slice(0, 50).map((id) => client.get<{ message: Message }>('/messages/' + id + '?limit=1').then((answer) => answer.message, () => null)))
    c.messages.utils.rows.merge(roots.filter((root) => root !== null), (row) => row.version)
    return list
  }
  /** A thread's root, read when messages lacks it (a thread that's unread but not in the first pages). */
  const ensureRoots = async (ids: string[]) => {
    const missing = ids.filter((id) => !c.messages.has(id))
    const roots = await Promise.all(missing.slice(0, 50).map((id) => runtime.client.get<{ message: Message }>('/messages/' + id + '?limit=1').then((answer) => answer.message, () => null)))
    c.messages.utils.rows.merge(roots.filter((root) => root !== null), (row) => row.version)
  }
  return { openInbox, ensureRoots }
}

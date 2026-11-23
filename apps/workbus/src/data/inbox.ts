// What reached the principal (design/workbus.md §6.1): mentions, and what's new in threads and doc
// discussions it follows, read from GET /events?for=me in one request. Each event's message is
// merged into messages, as an opened channel's are, so an inbox item has its newest reply, and its
// title when the thread's root isn't in memory. Roots aren't read one by one: opening an item reads
// its thread. The messages trim lets loose messages go past MESSAGES_KEPT, so the inbox reads again
// on mount.
import type { BusCollections } from './index.ts'
import type { BusRuntime } from './runtime.ts'
import type { BoardEvent, Message } from './types.ts'

/** How many of the newest events that reached me the inbox reads. */
export const INBOX_EVENTS = 100

export function inboxReads(runtime: BusRuntime, c: BusCollections) {
  let reading: Promise<Message[]> | null = null
  /** The messages that reached me, newest last, merged into messages. A read in flight is shared: a view mounted twice reads once. */
  const openInbox = (): Promise<Message[]> => (reading ??= read().finally(() => (reading = null)))
  const read = async (): Promise<Message[]> => {
    const page = await runtime.client.get<{ events: BoardEvent[]; cursor: string }>('/events?for=me&last=' + INBOX_EVENTS)
    const reached = new Map<string, Message>()
    for (const event of page.events) if (event.message && event.type === 'message.posted') reached.set(event.message.id, event.message)
    const list = [...reached.values()].sort((a, b) => Number(a.id) - Number(b.id))
    c.messages.utils.rows.merge(list, (row) => row.version)
    return list
  }
  return { openInbox }
}

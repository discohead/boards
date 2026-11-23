// Read state in the app (design/read-state.md): what the principal hasn't read, per channel and per
// thread it follows. GET /unread answers every count at once; the feed keeps them live from there (a
// root by someone else counts in its channel, a reply in a thread it follows, and a mention of it
// counts once more). Marking read (POST /read) writes no event, so it reaches the principal's other
// tabs over a BroadcastChannel, and another device asks GET /unread again when its window gains
// focus or its feed reconnects.
import { feedCollection, type Rows } from './collections.ts'
import type { BusRuntime } from './runtime.ts'
import type { BoardEvent, Message } from './types.ts'

/**
 * One count. A channel's `mentions` here are its roots' only; what a sidebar shows adds its
 * threads' (as GET /unread does), so marking a thread read takes them off the channel too.
 */
export type Unread = { key: string; kind: 'channel' | 'thread'; channel: string; thread: string | null; unread: number; mentions: number; read: string | null }

type Answer = { channels: { channel: string; unread: number; mentions: number; read: string | null }[]; threads: { thread: string; channel: string; unread: number; mentions: number; read: string | null }[]; cursor: string }

/** How long after the last event a burst waits before GET /unread. */
const REFRESH_MS = 250

export const channelKey = (path: string) => 'channel:' + path
export const threadKey = (id: string) => 'thread:' + id

/** The rows an answer from GET /unread stands for: a channel's mentions less its threads'. */
export function rowsOf(answer: Answer): Unread[] {
  const threadMentions = new Map<string, number>()
  for (const row of answer.threads) threadMentions.set(row.channel, (threadMentions.get(row.channel) ?? 0) + row.mentions)
  return [
    ...answer.channels.map((row): Unread => ({ key: channelKey(row.channel), kind: 'channel', channel: row.channel, thread: null, unread: row.unread, mentions: Math.max(0, row.mentions - (threadMentions.get(row.channel) ?? 0)), read: row.read })),
    ...answer.threads.map((row): Unread => ({ key: threadKey(row.thread), kind: 'thread', channel: row.channel, thread: row.thread, unread: row.unread, mentions: row.mentions, read: row.read })),
  ]
}

/** Whether a message's text mentions an actor: the board writes a mention as @[<actor ID>]. */
export const mentions = (message: Pick<Message, 'text'>, actor: string) => actor !== '' && message.text.includes('@[' + actor + ']')

/** What one event changes in the counts at once. A delete changes nothing here (`refresh`): only the board knows what it had counted. */
export function unreadChange(event: BoardEvent, rows: Pick<Rows<Unread>, 'get'>, runtime: Pick<BusRuntime, 'me' | 'following'>): { upserts?: Unread[]; refresh?: boolean } | void {
  const message = event.message
  if (!message) return
  if (event.type === 'message.deleted') return { refresh: true }
  if (event.type !== 'message.posted' || message.deleted || message.by.actor === runtime.me.actor) return
  const mentioned = mentions(message, runtime.me.actor)
  if (message.re === null) {
    const had = rows.get(channelKey(message.channel)) ?? { key: channelKey(message.channel), kind: 'channel' as const, channel: message.channel, thread: null, unread: 0, mentions: 0, read: null }
    // Counted already when it's at or before the channel's cursor (an event replayed over a fresh answer).
    if (had.read !== null && Number(message.id) <= Number(had.read)) return
    return { upserts: [{ ...had, unread: had.unread + 1, mentions: had.mentions + (mentioned ? 1 : 0) }] }
  }
  const root = message.re
  const had = rows.get(threadKey(root))
  if (!had && !mentioned && !runtime.following(root)) return
  if (had?.read && Number(message.id) <= Number(had.read)) return
  const row = had ?? { key: threadKey(root), kind: 'thread' as const, channel: message.channel, thread: root, unread: 0, mentions: 0, read: null }
  return { upserts: [{ ...row, unread: row.unread + 1, mentions: row.mentions + (mentioned ? 1 : 0) }] }
}

/** The counts, as a collection: every row from GET /unread, kept live from the feed. */
export const unread = feedCollection<Unread>({
  id: 'unread',
  getKey: (row) => row.key,
  load: async (runtime) => {
    const answer = await runtime.client.get<Answer>('/unread')
    return { rows: rowsOf(answer), cursor: Number(answer.cursor) }
  },
  // Counted at once from the feed so the sidebar bolds without waiting, then asked again: one
  // GET /unread is exact where counting alone would drift (what a delete took, a follow made elsewhere).
  apply: (event, rows, runtime) => {
    const message = event.message
    if (message && (event.type === 'message.deleted' || (event.type === 'message.posted' && message.by.actor !== runtime.me.actor))) runtime.unread?.soon()
    const change = unreadChange(event, rows, runtime)
    return change?.upserts ? { upserts: change.upserts } : undefined
  },
})

/** What a mark says to the principal's other tabs. */
type ReadNotice = { type: 'read'; key: string; read: string | null }

/**
 * Marking read and keeping the counts current: marks (POST /read) show at once, reach other tabs,
 * and the counts are asked for again on focus, on a reconnect, and after a delete.
 */
export function readState(runtime: BusRuntime, rows: Rows<Unread>) {
  const channel = typeof BroadcastChannel === 'undefined' ? null : new BroadcastChannel('workbus-read:' + runtime.client.url)
  const zero = (key: string, read: string | null) => {
    const had = rows.get(key)
    if (!had || (had.unread === 0 && had.mentions === 0 && had.read === read)) return
    rows.apply([{ ...had, unread: 0, mentions: 0, read }])
  }
  if (channel) channel.onmessage = (event: MessageEvent<ReadNotice>) => event.data?.type === 'read' && zero(event.data.key, event.data.read)

  let asking: Promise<void> | null = null
  let again = false
  /** GET /unread again; one at a time, and once more if asked while it was out. */
  const refresh = (): Promise<void> => {
    if (asking) {
      again = true
      return asking
    }
    asking = (async () => {
      try {
        const answer = await runtime.client.get<Answer>('/unread')
        const fresh = rowsOf(answer)
        const keys = new Set(fresh.map((row) => row.key))
        rows.apply(fresh, [...rows.map.keys()].filter((key) => !keys.has(key)))
      } finally {
        asking = null
        if (again) {
          again = false
          void refresh()
        }
      }
    })()
    return asking
  }

  /** Mark a channel or a thread read, up to now. */
  const markRead = async (target: { channel: string } | { thread: string }) => {
    const key = 'channel' in target ? channelKey(target.channel) : threadKey(target.thread)
    const read = runtime.feed?.cursor != null ? String(runtime.feed.cursor) : null
    zero(key, read)
    channel?.postMessage({ type: 'read', key, read } satisfies ReadNotice)
    try {
      const answer = await runtime.client.post<{ read: string; unread: number; mentions: number }>('/read', target)
      zero(key, answer.read)
      channel?.postMessage({ type: 'read', key, read: answer.read } satisfies ReadNotice)
    } catch {
      await refresh().catch(() => {})
    }
  }

  /** Ask again shortly: a burst of events is one GET /unread. */
  let timer: ReturnType<typeof setTimeout> | null = null
  const soon = () => {
    if (timer) clearTimeout(timer)
    timer = setTimeout(() => {
      timer = null
      void refresh().catch(() => {})
    }, REFRESH_MS)
  }

  const onFocus = () => void refresh().catch(() => {})
  if (typeof window !== 'undefined') window.addEventListener('focus', onFocus)
  const health = { error: () => {}, healthy: () => void refresh().catch(() => {}) }
  runtime.feed?.health.add(health)
  const close = () => {
    channel?.close()
    if (typeof window !== 'undefined') window.removeEventListener('focus', onFocus)
    runtime.feed?.health.delete(health)
  }
  return { refresh, soon, markRead, close }
}

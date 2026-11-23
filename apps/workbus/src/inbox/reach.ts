// What's unread for the principal (step 2's read state, design/read-state.md) and what reached it
// (GET /events?for=me): one store per page, read again (debounced) whenever someone else's message
// changes in the feed, when the window gains focus, and when another tab marks something read. One
// GET /unread answers every count, so reading it again stays exact where counting from the feed
// would drift. Marking read is optimistic: the count drops at once, and the next read confirms it.
import { useEffect, useSyncExternalStore } from 'react'
import { useBus, type Bus, type Message } from '@/data'

export type ChannelUnread = { channel: string; unread: number; mentions: number; read: string | null }
export type ThreadUnread = { thread: string; channel: string; unread: number; mentions: number; read: string }
export type ReachState = {
  ready: boolean
  channels: Map<string, ChannelUnread>
  threads: Map<string, ThreadUnread>
  /** The newest messages that reached me (mentions, and what's in threads I follow), newest last. */
  reached: Message[]
  cursor: number
}

const EMPTY: ReachState = { ready: false, channels: new Map(), threads: new Map(), reached: [], cursor: 0 }
const DEBOUNCE_MS = 250
const TABS = 'workbus.read'

class ReachStore {
  state: ReachState = EMPTY
  #listeners = new Set<() => void>()
  #bus: Bus
  #timer: ReturnType<typeof setTimeout> | null = null
  #reading = 0
  #tabs: BroadcastChannel | null = null
  #users = 0
  /** The newest change seen before the first read landed. */
  #seen = 0
  #stop: (() => void) | null = null
  constructor(bus: Bus) {
    this.#bus = bus
  }
  subscribe = (listener: () => void) => {
    this.#listeners.add(listener)
    return () => void this.#listeners.delete(listener)
  }
  get = () => this.state
  #set(state: ReachState) {
    this.state = state
    for (const listener of this.#listeners) listener()
  }

  /** Start following (the first view that needs it), or stop (the last one gone). */
  use() {
    if (this.#users++ === 0) this.#start()
    return () => {
      if (--this.#users === 0) this.#stop?.()
    }
  }

  #start() {
    const me = () => this.#bus.runtime.me.actor
    // Only what's newer than the last read counted: the rows a collection loads with (and replays) aren't news.
    const changes = this.#bus.messages.subscribeChanges((batch) => {
      let newest = 0
      for (const change of batch) {
        const message = change.value as Message | undefined
        if (message && !message.pending && message.by?.actor !== me()) newest = Math.max(newest, Number(message.version))
      }
      // Before the first read lands, keep the newest: if that read was counted before it, read again.
      if (!this.state.ready) this.#seen = Math.max(this.#seen, newest)
      else if (newest > this.state.cursor) this.refresh()
    })
    const focus = () => this.refresh()
    window.addEventListener('focus', focus)
    this.#tabs = typeof BroadcastChannel === 'undefined' ? null : new BroadcastChannel(TABS)
    if (this.#tabs) this.#tabs.onmessage = () => this.refresh()
    this.#stop = () => {
      changes.unsubscribe()
      window.removeEventListener('focus', focus)
      this.#tabs?.close()
      this.#tabs = null
    }
    this.refresh(0)
  }

  /** Read the counts and what reached me again, soon (several changes at once read once). */
  refresh(delay = DEBOUNCE_MS) {
    if (this.#timer) clearTimeout(this.#timer)
    this.#timer = setTimeout(() => void this.#read(), delay)
  }

  async #read() {
    const client = this.#bus.runtime.client
    const reading = ++this.#reading
    const [unread, reached] = await Promise.all([client.get<{ channels: ChannelUnread[]; threads: ThreadUnread[]; cursor: string }>('/unread'), this.#bus.openInbox()])
    await this.#bus.ensureRoots(unread.threads.map((thread) => thread.thread))
    if (reading !== this.#reading) return
    this.#set({
      ready: true,
      channels: new Map(unread.channels.map((row) => [row.channel, row])),
      threads: new Map(unread.threads.map((row) => [row.thread, row])),
      reached,
      cursor: Number(unread.cursor),
    })
    if (this.#seen > Number(unread.cursor)) this.refresh(0)
    this.#seen = 0
  }

  /** Mark a thread read (up to now, or up to a message): it leaves the counts at once. */
  async markRead(target: { thread: string } | { channel: string }, upto?: string) {
    const threads = new Map(this.state.threads)
    const channels = new Map(this.state.channels)
    if ('thread' in target) {
      const had = threads.get(target.thread)
      if (had) threads.set(target.thread, { ...had, unread: 0, mentions: 0, read: upto ?? String(this.state.cursor) })
    } else {
      const had = channels.get(target.channel)
      if (had) channels.set(target.channel, { ...had, unread: 0, mentions: 0, read: upto ?? String(this.state.cursor) })
    }
    this.#set({ ...this.state, threads, channels })
    ++this.#reading
    try {
      await this.#bus.runtime.client.post('/read', { ...target, ...(upto ? { upto } : {}) })
      this.#tabs?.postMessage('read')
    } finally {
      this.refresh(0)
    }
  }
}

const stores = new WeakMap<Bus['runtime'], ReachStore>()
export function reachOf(bus: Bus) {
  let store = stores.get(bus.runtime)
  if (!store) stores.set(bus.runtime, (store = new ReachStore(bus)))
  return store
}

/** The read state and what reached me, live, while a view that needs it is mounted. */
export function useReach() {
  const bus = useBus()
  const store = reachOf(bus)
  useEffect(() => (bus.runtime.mode === 'browser' ? store.use() : undefined), [bus, store])
  const state = useSyncExternalStore(store.subscribe, store.get, () => EMPTY)
  return { ...state, markRead: (target: { thread: string } | { channel: string }, upto?: string) => store.markRead(target, upto) }
}

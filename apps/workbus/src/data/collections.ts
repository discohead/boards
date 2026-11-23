// The app's collections over the bus (design/workbus.md §9.2): threads, messages, tasks, docs,
// actors, follows, and open docs' bodies. They're descriptors: each DbClient makes its own.
//
// On the server (a route loader), each reads its first page and the cursor it was read at, and its
// rows and cursor are dehydrated. In the browser, each starts from those rows and that cursor
// (syncMeta) and follows the board's one live feed from there, writing each event in one sync
// transaction. A browser collection the server didn't hand over loads its first page itself.
import { collectionOptions, type Collection, type DbClient } from '@tanstack/db'
import { runtimeOf, sharedRead, type BusRuntime } from './runtime.ts'
import type { Actor, BoardEvent, Channel, Doc, DocBody, Follow, Message, Thread } from './types.ts'

type Write<T> = { type: 'insert' | 'update'; key: string; value: T } | { type: 'delete'; key: string }
type Sync<T> = { begin: () => void; write: (message: Write<T>) => void; commit: () => unknown }

/** What a collection holds from the board: its synced rows, mirrored, so an event can read them. */
export class Rows<T extends object> {
  map = new Map<string, T>()
  #sync: Sync<T> | null = null
  #getKey: (row: T) => string
  constructor(getKey: (row: T) => string) {
    this.#getKey = getKey
  }
  bind(sync: Sync<T>) {
    this.#sync = sync
  }
  get = (key: string) => this.map.get(key)
  /** Rows read apart from the feed (an opened thread): kept only where they're no older than what's here. */
  merge(read: T[], version: (row: T) => number) {
    this.apply(read.filter((row) => {
      const had = this.map.get(this.#getKey(row))
      return !had || version(had) <= version(row)
    }))
  }
  /** One sync transaction: upserts and deletes, applied together. */
  apply(upserts: T[], deletes: string[] = []) {
    const sync = this.#sync
    if (!sync || (upserts.length === 0 && deletes.length === 0)) return
    sync.begin()
    for (const row of upserts) {
      const key = this.#getKey(row)
      sync.write({ type: this.map.has(key) ? 'update' : 'insert', key, value: row })
      this.map.set(key, row)
    }
    for (const key of deletes) {
      if (!this.map.has(key)) continue
      sync.write({ type: 'delete', key })
      this.map.delete(key)
    }
    sync.commit()
  }
}

export type BusUtils<T extends object> = { rows: Rows<T> }

export type FeedSpec<T extends object> = {
  id: string
  getKey: (row: T) => string
  /** The first page, and the cursor it was read at. */
  load: (runtime: BusRuntime) => Promise<{ rows: T[]; cursor: number }>
  /** What one event changes. */
  apply: (event: BoardEvent, rows: Rows<T>, runtime: BusRuntime) => { upserts?: T[]; deletes?: string[] } | void
  /** After each event: rows to let go of, to bound memory. */
  trim?: (rows: Rows<T>, runtime: BusRuntime) => string[]
}

type SyncMeta = { v: 1; cursor: number }

function feedCollection<T extends object>(spec: FeedSpec<T>) {
  return collectionOptions(spec.id, (db: DbClient) => {
    const runtime = runtimeOf(db)
    const rows = new Rows<T>(spec.getKey)
    let cursor: number | null = null
    let handed: number | null = null
    return {
      id: spec.id,
      getKey: spec.getKey,
      gcTime: 0,
      utils: { rows } satisfies BusUtils<T>,
      sync: {
        rowUpdateMode: 'full' as const,
        exportSyncMeta: (): SyncMeta | undefined => (cursor === null ? undefined : { v: 1, cursor }),
        importSyncMeta: (meta: unknown) => {
          if ((meta as SyncMeta | undefined)?.v === 1) handed = (meta as SyncMeta).cursor
        },
        sync: ({ begin, write, commit, markReady, fail, reportError, reportHealthy, collection }: { begin: () => void; write: (message: Write<T>) => void; commit: () => unknown; markReady: () => void; fail: (error: unknown) => void; reportError: (error: unknown) => void; reportHealthy: () => void; collection: Collection<T, string> }) => {
          rows.bind({ begin, write, commit })
          if (runtime.mode === 'render') {
            markReady()
            return () => {}
          }
          let stop = () => {}
          let stopped = false
          const health = { error: (error: unknown) => reportError(error), healthy: () => reportHealthy() }
          void (async () => {
            if (handed !== null) {
              // The server's rows are in the collection as hydration seeds: adopt them as this
              // sync's own (the same values, so nothing on screen changes), then follow from there.
              cursor = handed
              rows.apply([...collection.values()])
            } else {
              const first = await spec.load(runtime)
              if (stopped) return
              rows.apply(first.rows)
              cursor = first.cursor
            }
            if (runtime.mode === 'server' || !runtime.feed) return markReady()
            const from = cursor
            const follow = (event: BoardEvent) => {
              if (Number(event.cursor) <= from) return
              const change = spec.apply(event, rows, runtime)
              if (change) rows.apply(change.upserts ?? [], change.deletes ?? [])
              if (spec.trim) rows.apply([], spec.trim(rows, runtime))
              cursor = Number(event.cursor)
            }
            stop = await runtime.feed.subscribe(follow, from)
            markReady()
            runtime.feed.health.add(health)
          })().catch((error) => fail(error))
          return () => {
            stopped = true
            stop()
            runtime.feed?.health.delete(health)
          }
        },
      },
    }
  })
}

// -- the collections ---------------------------------------------------------------------------

const isRoot = (message: Message) => message.re === null
const docOf = (message: Message): Doc | null => (message.doc ? { ...message.doc, channel: message.channel, thread: message.thread, labels: message.labels } : null)
const now = async (runtime: BusRuntime) => Number((await runtime.client.get<{ cursor: string }>('/events?last=1')).cursor)

type ThreadEntry = { message: Message; replies: number; last: Message | null }
type Page<K extends string, T> = { [key in K]: T[] } & { cursor: string }
const firstThreads = (runtime: BusRuntime) => sharedRead(runtime, 'threads', () => runtime.client.get<Page<'threads', ThreadEntry>>('/threads?limit=50'))

/** A thread list entry as the threads collection holds it. */
export const threadOf = (entry: ThreadEntry): Thread => ({ id: entry.message.id, channel: entry.message.channel, root: entry.message, replies: entry.replies, last: entry.last })
export type { ThreadEntry }

/** Messages kept in memory beyond open threads and the first page's roots; past it the oldest go. */
export const MESSAGES_KEPT = 1000

export const messages = feedCollection<Message>({
  id: 'messages',
  getKey: (row) => row.id,
  // The first page of messages is the roots (and newest replies) of the first page of threads.
  load: async (runtime) => {
    const page = await firstThreads(runtime)
    return { rows: page.threads.flatMap((thread) => [thread.message, ...(thread.last ? [thread.last] : [])]), cursor: Number(page.cursor) }
  },
  apply: (event) => (event.message ? { upserts: [event.message] } : undefined),
  // Past MESSAGES_KEPT, the oldest messages not in an open thread go; opening the thread reads them again.
  trim: (rows, runtime) => {
    if (rows.map.size <= runtime.keep * 1.1) return []
    const loose = [...rows.map.values()].filter((message) => !runtime.open.has(message.re ?? message.id)).sort((a, b) => Number(a.id) - Number(b.id))
    return loose.slice(0, rows.map.size - runtime.keep).map((message) => message.id)
  },
})

export const threads = feedCollection<Thread>({
  id: 'threads',
  getKey: (row) => row.id,
  load: async (runtime) => {
    const page = await firstThreads(runtime)
    return { rows: page.threads.map(threadOf), cursor: Number(page.cursor) }
  },
  apply: (event, rows) => {
    const message = event.message
    if (!message) return
    if (isRoot(message)) {
      const had = rows.get(message.id)
      return { upserts: [{ id: message.id, channel: message.channel, root: message, replies: had?.replies ?? 0, last: had?.last ?? null }] }
    }
    const thread = rows.get(message.re!)
    if (!thread) return
    // Idempotent, so an event replayed over a row read after it changes nothing: replies come in ID
    // order, so a posted reply at or before the thread's last is already counted.
    const fresh = event.type === 'message.posted' && (!thread.last || Number(message.id) > Number(thread.last.id))
    const gone = event.type === 'message.deleted' && !thread.last?.deleted
    return { upserts: [{ ...thread, replies: Math.max(0, thread.replies + (fresh ? 1 : gone ? -1 : 0)), last: fresh || thread.last?.id === message.id ? message : thread.last }] }
  },
})

export const tasks = feedCollection<Message>({
  id: 'tasks',
  getKey: (row) => row.id,
  // Every open task (up to 500) and the newest 100 of any state. A full page's cursor is a page
  // cursor, not the board's, so the board's is read first: events after it replay idempotently.
  load: async (runtime) => {
    const before = await now(runtime)
    const [open, recent] = await Promise.all(['open&limit=500', 'all&latest=true&limit=100'].map((query) => runtime.client.get<Page<'tasks', { message: Message }>>('/tasks?state=' + query)))
    const byId = new Map([...recent!.tasks, ...open!.tasks].map((entry) => [entry.message.id, entry.message]))
    return { rows: [...byId.values()], cursor: before }
  },
  apply: (event, rows) => {
    const message = event.message
    if (!message) return
    if (message.task) return { upserts: [message] }
    if (rows.get(message.id)) return message.deleted ? { deletes: [message.id] } : { upserts: [message] }
  },
})

export const docs = feedCollection<Doc>({
  id: 'docs',
  getKey: (row) => row.id,
  load: async (runtime) => {
    const page = await runtime.client.get<Page<'threads', { message: Message }>>('/threads?label=board.doc&limit=500')
    return { rows: page.threads.map((thread) => docOf(thread.message)).filter((doc) => doc !== null), cursor: Number(page.cursor) }
  },
  apply: (event) => {
    const doc = event.message && docOf(event.message)
    if (!doc) return
    return event.message!.deleted ? { deletes: [doc.id] } : { upserts: [doc] }
  },
})

export const actors = feedCollection<Actor>({
  id: 'actors',
  getKey: (row) => row.id,
  load: async (runtime) => {
    const page = await runtime.client.get<Page<'actors', Actor>>('/actors')
    return { rows: page.actors, cursor: Number(page.cursor) }
  },
  apply: (event, rows) => {
    const actor = event.actor
    if (!actor) return
    const had = rows.get(actor.id)
    if (had && JSON.stringify(had) === JSON.stringify(actor)) return
    return { upserts: [actor] }
  },
})

// Follows aren't in the feed: the board keeps them aside. They load, and change by the follow
// write's own answer (actions.ts), and by a thread this caller starts (the board follows its author).
export const follows = feedCollection<Follow>({
  id: 'follows',
  getKey: (row) => row.thread,
  load: async (runtime) => {
    const [page, cursor] = await Promise.all([runtime.client.get<{ follows: Follow[] }>('/follows?limit=500'), now(runtime)])
    return { rows: page.follows, cursor }
  },
  apply: (event, rows, runtime) => {
    const message = event.message
    if (!message || event.type !== 'message.posted' || !isRoot(message) || rows.get(message.id) || message.by.actor !== runtime.me.actor) return
    return { upserts: [{ thread: message.id, discussion: null, channel: message.channel, cause: 'created', at: message.createdAt }] }
  },
})

/** Open docs' bodies: none at first; openDoc reads one, and doc events keep it current. */
export const bodies = feedCollection<DocBody>({
  id: 'doc-bodies',
  getKey: (row) => row.id,
  load: async (runtime) => ({ rows: [], cursor: await now(runtime) }),
  apply: (event, rows) => {
    const message = event.message
    if (!message?.doc || !rows.get(message.doc.id)) return
    return { upserts: [{ id: message.doc.id, revision: message.doc.revision, body: message.text }] }
  },
})

export const channels = feedCollection<Channel>({
  id: 'channels',
  getKey: (row) => row.path,
  load: async (runtime) => {
    const page = await runtime.client.get<Page<'channels', Channel>>('/channels?limit=500')
    return { rows: page.channels, cursor: Number(page.cursor) }
  },
  apply: (event, rows) => {
    const message = event.message
    if (event.type === 'channel.created' && typeof event.payload.path === 'string' && !rows.get(event.payload.path)) return { upserts: [{ path: event.payload.path, lastIndex: Number(event.cursor), messages: 0, threads: 0 }] }
    if (!message || event.type !== 'message.posted') return
    const had = rows.get(message.channel) ?? { path: message.channel, lastIndex: 0, messages: 0, threads: 0 }
    return { upserts: [{ ...had, lastIndex: Number(message.id), messages: had.messages + 1, threads: had.threads + (isRoot(message) ? 1 : 0) }] }
  },
})

/** Every collection a page's first load reads on the server. */
export const FIRST_PAGES = [channels, threads, messages, tasks, docs, actors, follows] as const

// The app's collections over the bus (design/workbus.md §9.2): threads, messages, tasks, docs,
// actors, and follows. Each loads its first page and the cursor it was read at, then follows the
// board's one live feed from that cursor, writing each event in one sync transaction. Messages
// and doc bodies past the first pages load when a thread or a doc is opened.
import { createCollection, type Collection } from '@tanstack/db'
import type { BusClient } from './client.ts'
import type { Feed } from './feed.ts'
import type { Actor, BoardEvent, Doc, DocBody, Follow, Message, Thread } from './types.ts'

type Sync<T extends object> = {
  begin: () => void
  write: (message: { type: 'insert' | 'update'; key: string; value: T } | { type: 'delete'; key: string }) => void
  commit: () => unknown
}

/** What a collection keeps of the board: its synced rows, mirrored, so an event can read them. */
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

export type FeedSpec<T extends object> = {
  id: string
  getKey: (row: T) => string
  /** The first page, and the cursor it was read at. */
  load: () => Promise<{ rows: T[]; cursor: number }>
  /** What one event changes. */
  apply: (event: BoardEvent, rows: Rows<T>) => { upserts?: T[]; deletes?: string[] } | void
}

/** A collection that loads its first page, then follows the feed from that page's cursor. */
export function feedCollection<T extends object>(feed: Feed, spec: FeedSpec<T>): { collection: Collection<T, string>; rows: Rows<T> } {
  const rows = new Rows<T>(spec.getKey)
  const collection = createCollection<T, string>({
    id: spec.id,
    getKey: spec.getKey,
    gcTime: 0,
    startSync: true,
    sync: {
      rowUpdateMode: 'full',
      sync: ({ begin, write, commit, markReady, fail, reportError, reportHealthy }) => {
        rows.bind({ begin, write: write as unknown as Sync<T>['write'], commit })
        let stop = () => {}
        let stopped = false
        const health = { error: (error: unknown) => reportError(error), healthy: () => reportHealthy() }
        void (async () => {
          const { rows: first, cursor } = await spec.load()
          if (stopped) return
          rows.apply(first)
          const follow = (event: BoardEvent) => {
            if (Number(event.cursor) <= cursor) return
            const change = spec.apply(event, rows)
            if (change) rows.apply(change.upserts ?? [], change.deletes ?? [])
          }
          stop = await feed.subscribe(follow, cursor)
          markReady()
          feed.health.add(health)
        })().catch((error) => fail(error))
        return () => {
          stopped = true
          stop()
          feed.health.delete(health)
        }
      },
    },
  })
  return { collection, rows }
}

// -- the six -----------------------------------------------------------------------------------

const isRoot = (message: Message) => message.re === null
const docOf = (message: Message): Doc | null => (message.doc ? { ...message.doc, channel: message.channel, thread: message.thread } : null)

type Page<K extends string, T> = { [key in K]: T[] } & { cursor: string }

export function busCollections(client: BusClient, feed: Feed) {
  // The first page of threads, read once for the two collections that start from it.
  let threadPage: Promise<Page<'threads', { message: Message; replies: number; last: Message | null }>> | null = null
  const firstThreads = () => (threadPage ??= client.get('/threads?limit=50'))
  const now = async () => Number((await client.get<{ cursor: string }>('/events?last=1')).cursor)

  const messages = feedCollection<Message>(feed, {
    id: 'messages',
    getKey: (row) => row.id,
    // The first page of messages is the roots of the first page of threads.
    load: async () => {
      const page = await firstThreads()
      return { rows: page.threads.flatMap((thread) => [thread.message, ...(thread.last ? [thread.last] : [])]), cursor: Number(page.cursor) }
    },
    apply: (event) => (event.message ? { upserts: [event.message] } : undefined),
  })

  const threads = feedCollection<Thread>(feed, {
    id: 'threads',
    getKey: (row) => row.id,
    load: async () => {
      const page = await firstThreads()
      return { rows: page.threads.map((thread) => ({ id: thread.message.id, channel: thread.message.channel, root: thread.message, replies: thread.replies, last: thread.last })), cursor: Number(page.cursor) }
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
      const fresh = event.type === 'message.posted'
      const gone = event.type === 'message.deleted'
      return { upserts: [{ ...thread, replies: Math.max(0, thread.replies + (fresh ? 1 : gone ? -1 : 0)), last: fresh || thread.last?.id === message.id ? message : thread.last }] }
    },
  })

  const tasks = feedCollection<Message>(feed, {
    id: 'tasks',
    getKey: (row) => row.id,
    load: async () => {
      const page = await client.get<Page<'tasks', { message: Message }>>('/tasks?state=all&limit=200')
      return { rows: page.tasks.map((entry) => entry.message), cursor: Number(page.cursor) }
    },
    apply: (event, rows) => {
      const message = event.message
      if (!message) return
      if (message.task) return { upserts: [message] }
      if (rows.get(message.id)) return message.deleted ? { deletes: [message.id] } : { upserts: [message] }
    },
  })

  const docs = feedCollection<Doc>(feed, {
    id: 'docs',
    getKey: (row) => row.id,
    load: async () => {
      const page = await client.get<Page<'threads', { message: Message }>>('/threads?label=board.doc&limit=500')
      return { rows: page.threads.map((thread) => docOf(thread.message)).filter((doc) => doc !== null), cursor: Number(page.cursor) }
    },
    apply: (event) => {
      const doc = event.message && docOf(event.message)
      if (!doc) return
      return event.message!.deleted ? { deletes: [doc.id] } : { upserts: [doc] }
    },
  })

  const actors = feedCollection<Actor>(feed, {
    id: 'actors',
    getKey: (row) => row.id,
    load: async () => {
      const page = await client.get<Page<'actors', Actor>>('/actors')
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
  // write's own answer (actions.ts), and by a post or a task made here (the board follows its author).
  const follows = feedCollection<Follow>(feed, {
    id: 'follows',
    getKey: (row) => row.thread,
    load: async () => {
      const [page, cursor] = await Promise.all([client.get<{ follows: Follow[] }>('/follows?limit=500'), now()])
      return { rows: page.follows, cursor }
    },
    apply: (event, rows) => {
      const message = event.message
      if (!message || event.type !== 'message.posted' || !isRoot(message) || rows.get(message.id)) return
      if (message.by.actor !== me.actor) return
      return { upserts: [{ thread: message.id, discussion: null, channel: message.channel, cause: 'created', at: message.createdAt }] }
    },
  })
  const me = { actor: '' }

  // Opened, not in the first pages: a thread's replies and a doc's body.
  const bodies = feedCollection<DocBody>(feed, {
    id: 'doc-bodies',
    getKey: (row) => row.id,
    load: async () => ({ rows: [], cursor: await now() }),
    apply: (event, rows) => {
      const message = event.message
      if (!message?.doc || !rows.get(message.doc.id)) return
      return { upserts: [{ id: message.doc.id, revision: message.doc.revision, body: message.text }] }
    },
  })

  return { messages, threads, tasks, docs, actors, follows, bodies, me }
}

export type BusCollections = ReturnType<typeof busCollections>

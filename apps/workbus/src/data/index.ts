// The data layer (design/workbus.md §9.2): the collections, the live feed, and the writes.
//
//   server, in a route loader:  readFirstPages(serverRuntime(...)) → a DbClient's dehydrated state
//   browser:                    <DbProvider client={browserDb()}><HydrationBoundary state={...}>
//                               then useBus() for the collections, the writes, and openThread/openDoc
import { DbClient, type Collection } from '@tanstack/db'
import { useDbClient } from '@tanstack/react-db'
import { BusClient, BusRefusal, type BusOptions } from './client.ts'
import { Feed } from './feed.ts'
import { actors, bodies, channels, docs, FIRST_PAGES, MESSAGES_KEPT, follows, messages, tasks, threadOf, threads, type BusUtils, type ThreadEntry } from './collections.ts'
import { busActions } from './actions.ts'
import { runtimeOf, type BusMode, type BusRuntime } from './runtime.ts'
import type { Actor, Channel, Doc, DocBody, Follow, Message, Thread } from './types.ts'

export { BusClient, BusRefusal, Feed, runtimeOf }
export type * from './types.ts'
export type { BusRuntime }

export function createRuntime(mode: BusMode, options: BusOptions & { keep?: number }): BusRuntime {
  const client = new BusClient(options)
  return { mode, client, feed: mode === 'browser' ? new Feed(client) : null, me: { actor: '' }, shared: new Map(), open: new Set(), keep: options.keep ?? MESSAGES_KEPT }
}

/**
 * The first pages, read on the server for one request: a DbClient's dehydrated state, rows and
 * cursors. At the deadline it gives what it has; a collection it doesn't hand over loads itself in
 * the browser.
 */
export async function readFirstPages(runtime: BusRuntime, options: { deadlineMs?: number; channel?: string } = {}) {
  const deadlineMs = options.deadlineMs ?? 2500
  const db = new DbClient({ bus: runtime })
  const materialize = db.collection.bind(db) as (descriptor: unknown) => Collection<object, string>
  const loads: Promise<unknown>[] = FIRST_PAGES.map((descriptor) => materialize(descriptor).preload())
  // The channel the page shows: its own first page of threads, as an opened channel reads it.
  if (options.channel) loads.push(Promise.all(loads).then(() => busOf(db).openChannel(options.channel!)))
  const timer = new Promise<'late'>((resolve) => setTimeout(() => resolve('late'), deadlineMs))
  const result = await Promise.race([Promise.all(loads).then(() => 'read' as const), timer])
  const state = db.dehydrate({ shouldDehydrateCollection: (collection) => collection.status === 'ready' })
  await db.cleanup()
  return { state, late: result === 'late' }
}

/** A DbClient whose collections follow one feed: the page's one, or a script's. */
export function liveDb(options: BusOptions & { keep?: number }): DbClient {
  const runtime = createRuntime('browser', options)
  runtime.shared.set('me', runtime.client.get<{ actor: string }>('/me').then((me) => (runtime.me.actor = me.actor)))
  return new DbClient({ bus: runtime })
}

let browser: DbClient | null = null
/** The page's one DbClient. */
export const browserDb = (options: BusOptions) => (browser ??= liveDb(options))

/** A DbClient for the server's render: it holds the loader's rows and never reads. */
export const renderDb = () => new DbClient({ bus: createRuntime('render', { url: 'https://render.invalid' }) })

type Of<T extends object> = Collection<T, string, BusUtils<T>>
export type BusCollections = { channels: Of<Channel>; threads: Of<Thread>; messages: Of<Message>; tasks: Of<Message>; docs: Of<Doc>; actors: Of<Actor>; follows: Of<Follow>; bodies: Of<DocBody> }

const buses = new WeakMap<DbClient, ReturnType<typeof makeBus>>()

function makeBus(db: DbClient) {
  const runtime = runtimeOf(db)
  const c = {
    channels: db.collection(channels),
    threads: db.collection(threads),
    messages: db.collection(messages),
    tasks: db.collection(tasks),
    docs: db.collection(docs),
    actors: db.collection(actors),
    follows: db.collection(follows),
    bodies: db.collection(bodies),
  } as unknown as BusCollections
  const actions = busActions(db, runtime, c)

  /** Open a thread: its replies, read now (up to 500) and kept in memory while it's open. */
  const openThread = async (id: string) => {
    runtime.open.add(id)
    const page = await runtime.client.get<{ message: Message; replies: Message[] }>('/messages/' + id + '?limit=500')
    c.messages.utils.rows.merge([page.message, ...page.replies], (row) => row.version)
    return page
  }
  /**
   * A channel's newest threads (the first pages are the whole board's), merged where they're no
   * older than what's here: the feed's events replayed over them change nothing.
   */
  const openChannel = async (path: string) => {
    const page = await runtime.client.get<{ threads: ThreadEntry[] }>('/threads?channel=' + encodeURIComponent(path) + '&limit=50')
    c.threads.utils.rows.merge(page.threads.map(threadOf), (row) => Number(row.last?.id ?? row.id) * 1e6 + row.root.version)
    c.messages.utils.rows.merge(page.threads.flatMap((entry) => [entry.message, ...(entry.last ? [entry.last] : [])]), (row) => row.version)
  }

  /** Close it: its replies may go from memory again (past MESSAGES_KEPT, oldest first). */
  const closeThread = (id: string) => runtime.open.delete(id)

  /** A doc's body, when it's opened; doc events keep it current from then on. */
  const openDoc = async (id: string) => {
    const page = await runtime.client.get<{ doc: { revision: string }; body: string }>('/docs/' + id)
    const had = c.bodies.utils.rows.get(id)
    if (!had || Number(had.revision) <= Number(page.doc.revision)) c.bodies.utils.rows.apply([{ id, revision: page.doc.revision, body: page.body }])
    return page
  }
  return { db, runtime, ...c, actions, openChannel, openThread, closeThread, openDoc }
}

/** The collections and writes of db (one set per DbClient). */
export function busOf(db: DbClient) {
  let bus = buses.get(db)
  if (!bus) buses.set(db, (bus = makeBus(db)))
  return bus
}

export type Bus = ReturnType<typeof busOf>

/** busOf the DbProvider's client. */
export const useBus = () => busOf(useDbClient())

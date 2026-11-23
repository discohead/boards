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
import { threadActions } from './thread-actions.ts'
import { readState, unread, type Unread } from './unread.ts'
import { taskActions } from './task-actions.ts'
import { inboxReads } from './inbox.ts'
import { runtimeOf, type BusMode, type BusRuntime, type Me } from './runtime.ts'
import type { Actor, Channel, Doc, DocBody, Follow, Message, Thread } from './types.ts'

export { BusClient, BusRefusal, Feed, runtimeOf }
export type * from './types.ts'
export { taskState, type ShownState } from './task-state.ts'
export type { BusRuntime, Me }

export function createRuntime(mode: BusMode, options: BusOptions & { keep?: number; gate?: boolean }): BusRuntime {
  const client = new BusClient(options)
  let markHydrated = () => {}
  const hydrated = options.gate ? new Promise<void>((resolve) => (markHydrated = resolve)) : Promise.resolve()
  return { mode, client, feed: mode === 'browser' ? new Feed(client) : null, me: { actor: '' }, shared: new Map(), open: new Set(), keep: options.keep ?? MESSAGES_KEPT, hydrated, markHydrated, following: () => false, unread: null, viewing: new Set() }
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
  const loads: Promise<unknown>[] = [...FIRST_PAGES, unread].map((descriptor) => materialize(descriptor).preload())
  let me: Me | null = null
  loads.push(runtime.client.get<Me>('/me').then((answer) => (me = answer)))
  // The channel the page shows: its own first page of threads, as an opened channel reads it.
  if (options.channel) loads.push(Promise.all(loads).then(() => busOf(db).openChannel(options.channel!)))
  const timer = new Promise<'late'>((resolve) => setTimeout(() => resolve('late'), deadlineMs))
  // A read the bus refuses leaves its collection out, as a late one is: the browser reads it itself.
  const result = await Promise.race([Promise.allSettled(loads).then(() => 'read' as const), timer])
  const state = db.dehydrate({ shouldDehydrateCollection: (collection) => collection.status === 'ready' })
  await db.cleanup()
  return { state, me: me as Me | null, late: result === 'late' }
}

/** A DbClient whose collections follow one feed: the page's one, or a script's. `me`, when the server read it, saves asking. */
export function liveDb(options: BusOptions & { keep?: number; me?: Me | null; gate?: boolean }): DbClient {
  const runtime = createRuntime('browser', options)
  if (options.me) Object.assign(runtime.me, options.me)
  runtime.shared.set('me', options.me ? Promise.resolve(runtime.me) : runtime.client.get<Me>('/me').then((me) => Object.assign(runtime.me, me)))
  return new DbClient({ bus: runtime })
}

let browser: DbClient | null = null
/** The page's one DbClient. */
export const browserDb = (options: BusOptions & { me?: Me | null }) => (browser ??= liveDb({ ...options, gate: true }))

/** A DbClient for the server's render: it holds the loader's rows and never reads. */
export const renderDb = (me?: Me | null) => {
  const runtime = createRuntime('render', { url: 'https://render.invalid' })
  if (me) Object.assign(runtime.me, me)
  return new DbClient({ bus: runtime })
}

type Of<T extends object> = Collection<T, string, BusUtils<T>>
export type BusCollections = { channels: Of<Channel>; threads: Of<Thread>; messages: Of<Message>; tasks: Of<Message>; docs: Of<Doc>; actors: Of<Actor>; follows: Of<Follow>; bodies: Of<DocBody>; unread: Of<Unread> }

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
    unread: db.collection(unread),
  } as unknown as BusCollections
  runtime.following = (thread) => c.follows.utils.rows.get(thread) !== undefined
  const reads = runtime.mode === 'browser' ? readState(runtime, c.unread.utils.rows) : null
  runtime.unread = reads
  const actions = { ...busActions(db, runtime, c), ...threadActions(db, runtime, c), markRead: (target: ({ channel: string } | { thread: string }) & { upto?: string }) => reads?.markRead(target) ?? Promise.resolve() }
  const taskWrites = taskActions(db, runtime, c)
  const inbox = inboxReads(runtime, c)

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
  const reading = new Map<string, Promise<{ threads: ThreadEntry[]; older?: string | null }>>()
  /** With `before` (a page's `older`), the page before it. Answers where the next page back starts, or null at the channel's first thread. */
  const openChannel = async (path: string, options: { before?: string } = {}) => {
    // One read at a time per page: a view mounted twice (React's dev double effects) asks once.
    const key = path + '\u0000' + (options.before ?? '')
    let read = reading.get(key)
    if (!read) reading.set(key, (read = runtime.client.get<{ threads: ThreadEntry[]; older?: string | null }>('/threads?channel=' + encodeURIComponent(path) + '&limit=50' + (options.before ? '&before=' + encodeURIComponent(options.before) : '')).finally(() => reading.delete(key))))
    const page = await read
    c.threads.utils.rows.merge(page.threads.map(threadOf), (row) => Number(row.last?.id ?? row.id) * 1e6 + row.root.version)
    c.messages.utils.rows.merge(page.threads.flatMap((entry) => [entry.message, ...(entry.last ? [entry.last] : [])]), (row) => row.version)
    return { older: page.older ?? null, more: (page.older ?? null) !== null }
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
  return { db, runtime, ...c, actions: { ...actions, task: taskWrites }, ...inbox, openChannel, openThread, closeThread, openDoc }
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

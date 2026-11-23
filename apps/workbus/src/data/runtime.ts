// What a DbClient's collections share: the bus client, the live feed (in the browser only), who
// the caller is, and the threads that are open. Each DbClient gets its own: one per request on the
// server, one for the page in the browser.
import type { DbClient } from '@tanstack/db'
import type { BusClient } from './client.ts'
import type { Feed } from './feed.ts'

export type BusMode =
  /** Reads the first pages and stops: a route loader's DbClient, whose state is dehydrated. */
  | 'server'
  /** Never reads: the server's render, from the loader's dehydrated rows only. */
  | 'render'
  /** Follows the feed from the cursor the server handed off (or loads first, when it didn't). */
  | 'browser'

export type Me = { actor: string; principal?: string; kind?: string; handle?: string; name?: string; can?: Record<string, string[]>; [key: string]: unknown }

export type BusRuntime = {
  mode: BusMode
  client: BusClient
  feed: Feed | null
  /** Who the caller is: GET /me's answer (actor, can, …), filled in by liveDb. */
  me: Me
  /** Reads collections share within one DbClient (the first page of threads). */
  shared: Map<string, Promise<unknown>>
  /** Threads open in a view: their messages stay in memory. */
  open: Set<string>
  /** How many messages to keep beyond open threads' (MESSAGES_KEPT by default). */
  keep: number
  /** Whether the caller follows a thread (from the follows collection, once it's there). */
  following: (thread: string) => boolean
  /** The read state's refresh (GET /unread again), once the browser's read state is running. */
  unread: { refresh: () => Promise<void>; soon: () => void } | null
  /** Channels shown in a view: their newest messages stay in memory. */
  viewing: Set<string>
}

export const runtimeOf = (db: DbClient): BusRuntime => db.requireDependency<BusRuntime>('bus')

export const sharedRead = <T>(runtime: BusRuntime, key: string, read: () => Promise<T>): Promise<T> => {
  let found = runtime.shared.get(key) as Promise<T> | undefined
  if (!found) runtime.shared.set(key, (found = read()))
  return found
}

// A sync provider: one platform, as the board's own sync runs it. A deployment declares its syncs
// (defineBoards(() => ({ sync: { github: githubProvider({ … }) } }))), and the board runs them in two
// satellites per key: the Inbox (inbox:<board>:<key>) takes the platform's webhooks and imports
// them, and the courier (the Mailbox of the @sync:<key> subscription) copies what's written on the
// board back to the platform. A provider is the platform's half of both: it verifies and normalizes
// what comes in, says what each event means as board imports, and posts, edits, deletes, reacts,
// and shows typing there. Its credentials come through the secrets accessor (secrets.ts).
import type { Caller } from '../ledger/core.ts'

/** A platform user, as an import names its author. Its ID starts with the sync's key. */
export type SyncUser = { id: string; handle: string; name: string; avatar: string | null; isBot: boolean }

/** One normalized platform event for the Inbox: kept under its platform ID (a retry has the same one), in its platform thread's lane. */
export type InboxEvent<E = unknown> = {
  /** The platform's ID for it: a retry of the same delivery has the same one. At most 300 characters. */
  id: string
  /** Its platform thread (key-prefixed): one thread's events import in order. */
  thread: string
  /** Its platform channel (key-prefixed), for reading the Inbox by channel. */
  channel: string
  /** What the provider's import takes. */
  event: E
  /** The raw payload, kept in the Inbox for its retention, never on the board. */
  raw?: unknown
}

/** What a webhook comes to: the events to keep, and the answer when it isn't the usual one (a challenge, a 401). */
export type Received<E = unknown> = { events: InboxEvent<E>[]; response?: Response }

/** A board call as a satellite: its value, or a thrown Error with the board's status and code. */
export type Call = (method: string, body: unknown) => Promise<any>

/** What an import gets: the sync's key, board calls as the sync, and the board root of a platform thread. */
export type ImportTools = { key: string; call: Call; rootOf: (thread: string) => Promise<string | null>; attempt: number; last: boolean }

/**
 * The platform's echo of what the courier posted there, when it can come before the courier's
 * receipt: wait for the receipt (it lands as nothing then), and on the Inbox's last try import it as
 * what it is (the bot said it some other way).
 */
export async function ownEcho(tools: ImportTools, thread: string, message: string): Promise<boolean> {
  const found = await tools.call('syncFind', { thread, message })
  if (found.message) return true
  if (!tools.last) throw new SyncRetry('the bot' + "'" + 's own message ' + message + ' has no receipt yet')
  return false
}

/** A board message, as the courier hands it to a provider. */
export type OutboundMessage = { id: string; re: string | null; thread: string; text: string; author: { name: string; handle: string } | null }

/** Where a board message is on the platform: its platform thread and message. */
export type Copy = { thread: string; message: string }

export type CourierTools = { key: string }

export interface SyncProvider<E = any> {
  /** The platform's name, as discovery lists it. */
  readonly platform: string
  /** A webhook: verified (a bad signature or a stale one is a 401 response and no events), then normalized. */
  receive(request: Request, tools: { key: string }): Promise<Received<E>>
  /** What one kept event means on the board: syncImport calls, as the sync. */
  import(event: E, tools: ImportTools): Promise<unknown>
  /** A board message, posted in a platform thread (thread) or, for a root synced to a channel (thread null), as a new one. */
  post(input: { target: string; thread: string | null; message: OutboundMessage }, tools: CourierTools): Promise<Copy>
  edit?(input: { target: string; copy: Copy; message: OutboundMessage }, tools: CourierTools): Promise<void>
  delete?(input: { target: string; copy: Copy }, tools: CourierTools): Promise<void>
  react?(input: { target: string; copy: Copy; emoji: string; remove: boolean }, tools: CourierTools): Promise<void>
  startTyping?(input: { target: string; thread: string; status?: string }, tools: CourierTools): Promise<void>
}

/** The platform refused for good (a 4xx that isn't a rate limit): the courier records the failure now. */
export class SyncRefused extends Error {}
/** The platform is busy, or the board isn't ready yet: try again later. */
export class SyncRetry extends Error {}

export const SATELLITE = 'boards:sync:'

/** A sync's Inbox, by board and key. */
export const inboxName = (board: string, key: string) => 'inbox:' + board + ':' + key
/** The courier's subscription of a sync key: matched like a watcher, delivered by its Mailbox (<board>:@sync:<key>). */
export const courierId = (key: string) => '@sync:' + key

/** A sync's satellites as a caller: the board's own, and the only callers that import or receipt under its key. */
export const satelliteCaller = (key: string, which: 'inbox' | 'courier'): Caller => ({
  principal: { id: SATELLITE + key, kind: 'deployment', handle: key + '-sync', name: key + ' sync (' + which + ')', facts: null, expiresAt: null, own: true },
  profile: null,
  narrow: null,
  via: 'sync',
})

/** The sync key a caller is a satellite of, or null. */
export const satelliteKey = (caller: Caller): string | null => (caller.via === 'sync' && caller.principal.id.startsWith(SATELLITE) ? caller.principal.id.slice(SATELLITE.length) : null)

type Ledger = { call(caller: Caller, method: string, input: unknown, mount?: unknown): Promise<{ ok: true; value: any } | { ok: false; failure: { status: number; code: string; message: string } }> }

/** Board calls as one of a sync's satellites. */
export function satelliteCall(ledger: Ledger, key: string, which: 'inbox' | 'courier', mount?: unknown): Call {
  const caller = satelliteCaller(key, which)
  return async (method, body) => {
    const answer = await ledger.call(caller, method, body, mount)
    if (!answer.ok) throw Object.assign(new Error(answer.failure.code + ': ' + answer.failure.message), answer.failure)
    return answer.value
  }
}

/** The board's root for a platform thread, or null when it never came in. */
export async function rootOf(call: Call, thread: string): Promise<string | null> {
  const found = await call('syncFind', { thread })
  if (!found.thread) return null
  return (await call('syncThread', { thread: found.thread })).root
}

/** A text cut to what a board message holds. */
export const trim = (text: string, max = 9000) => (text.length <= max ? text : text.slice(0, max) + '\n\n…')

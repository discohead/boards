// How a write settles, for every action file: it shows at once (onMutate), and its transaction
// stays open until the feed brings the board's own event for it back, so the pending rows and the
// board's rows swap in one step. After ECHO_MS without the echo, the write's answer stands in.
import type { DbClient, Transaction } from '@tanstack/db'
import type { Feed } from './feed.ts'
import type { BoardEvent } from './types.ts'

/** How long a write waits for its echo before its answer stands in. */
export const ECHO_MS = 10_000

/** An optimistic write on db: onMutate's changes show at once; mutationFn persists them and waits for the echo. */
export const action = <V>(db: DbClient, options: { onMutate: (input: V) => void; mutationFn: (input: V) => Promise<void> }) => (input: V): Transaction => {
  const transaction = db.createTransaction({ mutationFn: () => options.mutationFn(input) })
  transaction.mutate(() => options.onMutate(input))
  return transaction
}

export type Echo<A> = {
  /** The write's client ID: its echo is the message.posted whose payload.clientId is this. */
  clientId?: string
  /** The echo is the first event from now on that this matches (asked before the request, so a fast echo isn't missed). */
  test?: (event: BoardEvent) => boolean
  /** A fallback: the echo is the event at this cursor, read from the answer (a post's message.version), for a board that doesn't carry client IDs. */
  cursor?: (answer: A) => number | null
  /** Told which way it settled (the checks read it). */
  onSettled?: (settled: Settled) => void
}

/** Which way a write settled, for the checks: its client ID, a test, the cursor, or the answer after ECHO_MS. */
export type Settled = 'clientId' | 'test' | 'cursor' | 'answer'

/** The echo of a write made with a client ID. */
export const byClientId = (id: string) => (event: BoardEvent) => event.type === 'message.posted' && event.payload.clientId === id

/**
 * Send a write, then wait for its echo (echo.test or echo.cursor); after ECHO_MS, call fallback
 * with the answer (write it, or read the row again). A refusal throws, and the write rolls back.
 */
export async function sendAndSettle<A>(feed: Feed, send: () => Promise<A>, echo: Echo<A>, fallback: (answer: A) => unknown): Promise<A> {
  const test = echo.clientId !== undefined ? byClientId(echo.clientId) : echo.test
  const waiter = test ? feed.next(test) : null
  let answer: A
  try {
    answer = await send()
  } catch (error) {
    waiter?.cancel()
    throw error
  }
  const cursor = echo.cursor?.(answer) ?? null
  let timer: ReturnType<typeof setTimeout> | undefined
  const ways: Promise<Settled>[] = [new Promise<Settled>((resolve) => (timer = setTimeout(() => resolve('answer'), ECHO_MS)))]
  if (waiter) ways.push(waiter.promise.then(() => (echo.clientId !== undefined ? 'clientId' : 'test')))
  // The client ID's event is handed out before the feed's cursor moves past it, so it wins when it's there.
  if (cursor !== null) ways.push(feed.reached(cursor).then(() => new Promise<Settled>((resolve) => setTimeout(() => resolve('cursor'), 0))))
  if (!waiter && cursor === null) ways.push(Promise.resolve('answer'))
  const settled = await Promise.race(ways)
  clearTimeout(timer)
  waiter?.cancel()
  if (settled === 'answer') await fallback(answer)
  echo.onSettled?.(settled)
  return answer
}

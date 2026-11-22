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
  /** The echo is the first event from now on that this matches (asked before the request, so a fast echo isn't missed). */
  test?: (event: BoardEvent) => boolean
  /** Or: the echo is the event at this cursor, read from the answer (a post's message.version). */
  cursor?: (answer: A) => number | null
}

/**
 * Send a write, then wait for its echo (echo.test or echo.cursor); after ECHO_MS, call fallback
 * with the answer (write it, or read the row again). A refusal throws, and the write rolls back.
 */
export async function sendAndSettle<A>(feed: Feed, send: () => Promise<A>, echo: Echo<A>, fallback: (answer: A) => unknown): Promise<A> {
  const waiter = echo.test ? feed.next(echo.test) : null
  let answer: A
  try {
    answer = await send()
  } catch (error) {
    waiter?.cancel()
    throw error
  }
  const cursor = echo.cursor?.(answer) ?? null
  const seen = cursor !== null ? feed.reached(cursor) : waiter ? waiter.promise : Promise.resolve()
  let timer: ReturnType<typeof setTimeout> | undefined
  const echoed = await Promise.race([seen.then(() => true), new Promise<false>((resolve) => (timer = setTimeout(() => resolve(false), ECHO_MS)))])
  clearTimeout(timer)
  waiter?.cancel()
  if (!echoed) await fallback(answer)
  return answer
}

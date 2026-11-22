// One connection to the board's live feed (GET /events as SSE), shared by every collection. It
// reads with fetch, not EventSource, so a bearer token works as well as the Access cookie. The
// Gateway ends a stream after about 280 s; the feed reconnects after the last cursor it saw.
import type { BusClient } from './client.ts'
import type { BoardEvent } from './types.ts'

export type FeedListener = (event: BoardEvent) => void
export type FeedHealth = { error: (error: unknown) => void; healthy: () => void }
type Waiter = { cursor: number; resolve: () => void }

const RECENT = 2000

export class Feed {
  #client: BusClient
  #listeners = new Set<FeedListener>()
  #waiters: Waiter[] = []
  /** Events handed out after #recentFrom, in order, so a collection that loads later catches up. */
  #recent: BoardEvent[] = []
  #recentFrom = 0
  #abort: AbortController | null = null
  #retry = 0
  /** The cursor the feed has read to: every event at or before it has been handed out. */
  cursor: number | null = null
  health = new Set<FeedHealth>()

  constructor(client: BusClient) {
    this.#client = client
  }

  /**
   * Hand listener every event after cursor `after`, in order, and from then on each as it comes.
   * The first subscriber starts the feed at its cursor. One that loaded at an older cursor than
   * the feed keeps is caught up from GET /events first.
   */
  async subscribe(listener: FeedListener, after: number): Promise<() => void> {
    if (this.cursor === null) {
      this.#recentFrom = after
      this.#start(after)
    } else {
      let at = after
      while (at < this.#recentFrom) {
        const page = await this.#client.get<{ events: BoardEvent[]; cursor: string }>('/events?after=' + at)
        for (const event of page.events) if (Number(event.cursor) <= this.#recentFrom) listener(event)
        if (Number(page.cursor) <= at) break
        at = Number(page.cursor)
      }
      for (const event of this.#recent) if (Number(event.cursor) > Math.max(after, at)) listener(event)
    }
    this.#listeners.add(listener)
    return () => this.#listeners.delete(listener)
  }

  /** The first event handed out from now on that test matches: ask before the write, await after its answer. */
  next(test: (event: BoardEvent) => boolean): { promise: Promise<BoardEvent>; cancel: () => void } {
    let listener: FeedListener = () => {}
    const promise = new Promise<BoardEvent>((resolve) => {
      listener = (event) => {
        if (!test(event)) return
        this.#listeners.delete(listener)
        resolve(event)
      }
      this.#listeners.add(listener)
    })
    return { promise, cancel: () => this.#listeners.delete(listener) }
  }

  /** Resolves once the feed has handed out everything up to cursor. */
  reached(cursor: number): Promise<void> {
    if (this.cursor !== null && this.cursor >= cursor) return Promise.resolve()
    return new Promise((resolve) => this.#waiters.push({ cursor, resolve }))
  }

  close() {
    this.#abort?.abort()
    this.#abort = null
  }

  #advance(cursor: number) {
    if (this.cursor !== null && cursor <= this.cursor) return
    this.cursor = cursor
    const due = this.#waiters.filter((waiter) => waiter.cursor <= cursor)
    this.#waiters = this.#waiters.filter((waiter) => waiter.cursor > cursor)
    for (const waiter of due) waiter.resolve()
  }

  #hand(event: BoardEvent) {
    const cursor = Number(event.cursor)
    if (this.cursor !== null && cursor <= this.cursor) return
    this.#recent.push(event)
    if (this.#recent.length > RECENT) this.#recentFrom = Number(this.#recent.splice(0, this.#recent.length - RECENT).at(-1)!.cursor)
    for (const listener of this.#listeners) listener(event)
    this.#advance(cursor)
  }

  #start(after: number) {
    this.cursor = after
    const abort = new AbortController()
    this.#abort = abort
    void this.#run(abort.signal)
  }

  async #run(signal: AbortSignal) {
    while (!signal.aborted) {
      try {
        const response = await this.#client.raw('/events?after=' + this.cursor, { headers: { accept: 'text/event-stream' }, signal })
        if (!response.ok || !response.body) throw new Error('the feed answered ' + response.status)
        if (this.#retry) for (const health of this.health) health.healthy()
        this.#retry = 0
        await this.#read(response.body, signal)
      } catch (error) {
        if (signal.aborted) return
        this.#retry++
        for (const health of this.health) health.error(error)
        await new Promise((resolve) => setTimeout(resolve, Math.min(30_000, 500 * 2 ** this.#retry)))
      }
    }
  }

  async #read(body: ReadableStream<Uint8Array>, signal: AbortSignal) {
    const reader = body.pipeThrough(new TextDecoderStream() as unknown as TransformStream<Uint8Array, string>).getReader()
    let buffer = ''
    while (!signal.aborted) {
      const { value, done } = await reader.read()
      if (done) return
      buffer += value
      let end: number
      while ((end = buffer.indexOf('\n\n')) >= 0) {
        const block = buffer.slice(0, end)
        buffer = buffer.slice(end + 2)
        let id: string | null = null
        let data = ''
        for (const line of block.split('\n')) {
          if (line.startsWith('id: ')) id = line.slice(4)
          else if (line.startsWith('data: ')) data += line.slice(6)
        }
        if (data) this.#hand(JSON.parse(data) as BoardEvent)
        else if (id !== null && /^\d+$/.test(id)) this.#advance(Number(id))
      }
    }
  }
}

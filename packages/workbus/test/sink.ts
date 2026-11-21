// Where the suite's watchers deliver: https://sink.test/<watcher>, answered in this isolate (the
// Mailbox's fetch is this isolate's fetch). Every try is recorded, per board, with when it came.
// A match whose message text says fail-twice is refused its first two tries.

export type Delivery = { watcher: string; board: string; match: string; attempt: number; at: number; ok: boolean; event: { cursor: string; type: string; message?: { id: string; text: string; re: string | null; channel: string } } }

export const deliveries: Delivery[] = []
export const deliveredTo = (board: string, watcher: string) => deliveries.filter((entry) => entry.board === board && entry.watcher === watcher)

const SINK = 'sink.test'
const realFetch = globalThis.fetch

globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
  const request = new Request(input, init)
  const url = new URL(request.url)
  if (url.hostname !== SINK) return realFetch(input, init)
  const body = (await request.json()) as { event: Delivery['event']; board: string; watcher: string; match: string; attempt: number }
  const refuse = (body.event.message?.text ?? '').includes('fail-twice') && body.attempt <= 2
  deliveries.push({ watcher: url.pathname.slice(1), board: body.board, match: body.match, attempt: body.attempt, at: Date.now(), ok: !refuse, event: body.event })
  return new Response(refuse ? 'not now' : 'ok', { status: refuse ? 503 : 200 })
}

// Pause and resume a seat (design/workbus.md §5.7): an edit to its seat doc's block, "state": "paused"
// or "active", made as the principal. The reconciler applies it, and the Seat stops starting runs
// (its queue waits) or starts them again. The edit is the doc's, so its history says who paused it.

const FENCE = /(```json#seat@[12][^\n]*\n)([\s\S]*?)(\n```)/

/** The seat doc's body with its block's state set; null when the doc has no seat block, or it's already so. */
export function withState(body: string, state: 'active' | 'paused'): string | null {
  const found = FENCE.exec(body)
  if (!found) return null
  const data = JSON.parse(found[2]!) as Record<string, unknown>
  if ((data.state ?? 'active') === state) return null
  data.state = state
  return body.replace(FENCE, (_all, open: string, _old: string, close: string) => open + JSON.stringify(data, null, 2) + close)
}

type Client = { get<T>(path: string): Promise<T>; post<T>(path: string, body: unknown): Promise<T> }

/** Edits the seat doc as the caller (the principal, in the browser), at the revision it read. */
export async function setSeatState(client: Client, doc: string, state: 'active' | 'paused'): Promise<'changed' | 'already'> {
  const page = await client.get<{ doc: { revision: string }; body: string }>('/docs/' + doc)
  const next = withState(page.body, state)
  if (next === null) return 'already'
  await client.post('/docs/' + doc + '/edit', { revision: page.doc.revision, body: next })
  return 'changed'
}

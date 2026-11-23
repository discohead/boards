// Writes, each optimistic: it shows at once, and settles when the feed brings the board's own
// event for it back (a post's answer says which: its message's `version` is that event's cursor;
// an edit's is the next message.edited for it). A refusal rolls it back. Each write carries a client ID (`id`), so sending it again
// after a lost answer posts it once.
import { safeRandomUUID, type DbClient } from '@tanstack/db'
import { action, sendAndSettle, type Settled } from './settle.ts'
import type { BusCollections } from './index.ts'
import type { BusRuntime } from './runtime.ts'
import type { Follow, Message } from './types.ts'

export function busActions(db: DbClient, runtime: BusRuntime, c: BusCollections) {
  const { client } = runtime
  const feed = runtime.feed!
  type Merges = { merge: (rows: Message[], version: (row: Message) => number) => void }
  /** Send a write that answers its message; it settles on that message's event (its version is the event's cursor). */
  /** The way each write settled, by client ID, newest last (for the checks). */
  const settledBy = new Map<string, Settled>()
  /**
   * Send a write made with client ID id; it settles on the message.posted carrying that ID, or (on a
   * board that doesn't carry client IDs) on the event at its message's version.
   */
  const settle = (id: string, send: () => Promise<Message>, into: Merges[]) =>
    sendAndSettle(feed, send, { clientId: id, cursor: (message) => message.version, onSettled: (way) => settledBy.set(id, way) }, (message) => {
      for (const rows of into) rows.merge([message], (row) => row.version)
    })

  const draft = (fields: Partial<Message> & { id: string; channel: string; text: string }): Message => ({
    re: null,
    replyTo: null,
    thread: fields.id,
    labels: {},
    reactions: {},
    by: { actor: runtime.me.actor, principal: runtime.me.actor, profile: null },
    createdAt: new Date().toISOString(),
    editedAt: null,
    deleted: false,
    version: 0,
    revision: 0,
    pending: fields.id,
    ...fields,
  })

  /** A post in a channel, or a reply in a thread. */
  const post = action<{ channel?: string; re?: string; text: string; id?: string }>(db, {
    onMutate: (input) => {
      const id = (input.id ??= 'web-' + safeRandomUUID())
      const root = c.threads.get(input.re ?? '')
      const message = draft({ id, channel: input.channel ?? root?.channel ?? '', text: input.text, re: input.re ?? null })
      c.messages.insert(message)
      if (!input.re) c.threads.insert({ id, channel: message.channel, root: message, replies: 0, last: null })
      else if (root)
        c.threads.update(input.re, (thread) => {
          thread.replies += 1
          thread.last = message
        })
    },
    mutationFn: async (input) => {
      await settle(input.id!, async () => (await client.post<{ message: Message }>('/messages', input.re ? { re: input.re, text: input.text, id: input.id } : { channel: input.channel, text: input.text, id: input.id })).message, [c.messages.utils.rows])
    },
  })

  const edit = action<{ id: string; text: string }>(db, {
    onMutate: ({ id, text }) => {
      c.messages.update(id, (message) => {
        message.text = text
        message.editedAt = new Date().toISOString()
      })
    },
    mutationFn: async ({ id, text }) => {
      // An edit answers { ok: true }, so its echo is the next message.edited for this message.
      await sendAndSettle(feed, () => client.post('/messages/' + id + '/edit', { text }), { test: (event) => event.type === 'message.edited' && event.message?.id === id }, async () => {
        const { message } = await client.get<{ message: Message }>('/messages/' + id + '?limit=1')
        c.messages.utils.rows.merge([message], (row) => row.version)
      })
    },
  })

  /** Follow a thread, or stop. Follows aren't in the feed: this settles on the write's own answer. */
  const follow = action<{ thread: string; on: boolean }>(db, {
    onMutate: ({ thread, on }) => {
      const had = c.follows.get(thread)
      if (on && !had) c.follows.insert({ thread, discussion: null, channel: c.threads.get(thread)?.channel ?? '', cause: 'followed', at: new Date().toISOString() })
      if (!on && had) c.follows.delete(thread)
    },
    mutationFn: async ({ thread, on }) => {
      const answer = await client.post<{ following: boolean; thread: string; discussion: string | null }>('/messages/' + thread + '/follow', { on })
      const row: Follow = { thread: answer.thread, discussion: answer.discussion, channel: c.threads.get(thread)?.channel ?? '', cause: 'followed', at: new Date().toISOString() }
      if (answer.following) c.follows.utils.rows.apply([row])
      else c.follows.utils.rows.apply([], [answer.thread])
    },
  })

  /**
   * A doc. `re` makes it a task's doc (POST /docs {re}, which step 2 adds to the framework); until
   * then the board refuses it, and the write rolls back.
   */
  const createDoc = async (input: { channel: string; slug: string; body: string; re?: string }) => {
    const id = 'web-' + safeRandomUUID()
    return settle(id, async () => (await client.post<{ message: Message }>('/docs', { ...input, id })).message, [c.messages.utils.rows])
  }

  return { post, edit, follow, createDoc, settledBy }
}

// Writes, each optimistic: it shows at once, and settles when the feed brings the board's own
// event for it back (a post's answer says which: its message's `version` is that event's cursor;
// an edit's is the next message.edited for it). A refusal rolls it back. Each write carries a client ID (`id`), so sending it again
// after a lost answer posts it once.
import { createOptimisticAction, safeRandomUUID } from '@tanstack/db'
import type { BusClient } from './client.ts'
import type { BusCollections } from './collections.ts'
import type { Feed } from './feed.ts'
import type { Follow, Message } from './types.ts'

/** How long a write waits for its echo before it takes its own answer as the row. */
const ECHO_MS = 10_000

export function busActions(client: BusClient, feed: Feed, c: BusCollections) {
  /** The board took the write: wait for its event in the feed, or after ECHO_MS write the answer itself. */
  const settle = async (message: Message, into: { merge: (rows: Message[], version: (row: Message) => number) => void }[]) => {
    const echoed = await Promise.race([feed.reached(message.version).then(() => true), new Promise<false>((resolve) => setTimeout(() => resolve(false), ECHO_MS))])
    if (!echoed) for (const rows of into) rows.merge([message], (row) => row.version)
  }

  const draft = (fields: Partial<Message> & { id: string; channel: string; text: string }): Message => ({
    re: null,
    replyTo: null,
    thread: fields.id,
    labels: {},
    reactions: {},
    by: { actor: c.me.actor, principal: c.me.actor, profile: null },
    createdAt: new Date().toISOString(),
    editedAt: null,
    deleted: false,
    version: 0,
    revision: 0,
    pending: fields.id,
    ...fields,
  })

  /** A post in a channel, or a reply in a thread. */
  const post = createOptimisticAction<{ channel?: string; re?: string; text: string; id?: string }>({
    onMutate: (input) => {
      const id = (input.id ??= 'web-' + safeRandomUUID())
      const root = c.threads.collection.get(input.re ?? '')
      const message = draft({ id, channel: input.channel ?? root?.channel ?? '', text: input.text, re: input.re ?? null })
      c.messages.collection.insert(message)
      if (!input.re) c.threads.collection.insert({ id, channel: message.channel, root: message, replies: 0, last: null })
      else if (root)
        c.threads.collection.update(input.re, (thread) => {
          thread.replies += 1
          thread.last = message
        })
    },
    mutationFn: async (input) => {
      const { message } = await client.post<{ message: Message }>('/messages', input.re ? { re: input.re, text: input.text, id: input.id } : { channel: input.channel, text: input.text, id: input.id })
      await settle(message, [c.messages.rows])
    },
  })

  const edit = createOptimisticAction<{ id: string; text: string }>({
    onMutate: ({ id, text }) => {
      c.messages.collection.update(id, (message) => {
        message.text = text
        message.editedAt = new Date().toISOString()
      })
    },
    mutationFn: async ({ id, text }) => {
      // An edit answers { ok: true }, so its echo is the next message.edited for this message.
      const echo = feed.next((event) => event.type === 'message.edited' && event.message?.id === id)
      try {
        await client.post('/messages/' + id + '/edit', { text })
      } catch (error) {
        echo.cancel()
        throw error
      }
      const echoed = await Promise.race([echo.promise.then(() => true), new Promise<false>((resolve) => setTimeout(() => resolve(false), ECHO_MS))])
      if (!echoed) {
        echo.cancel()
        const { message } = await client.get<{ message: Message }>('/messages/' + id + '?limit=1')
        c.messages.rows.merge([message], (row) => row.version)
      }
    },
  })

  const createTask = createOptimisticAction<{ channel: string; text: string; id?: string }>({
    onMutate: (input) => {
      const id = (input.id ??= 'web-' + safeRandomUUID())
      const me = c.me.actor
      c.tasks.collection.insert(draft({ id, channel: input.channel, text: input.text, labels: { 'board.task': 'ready' }, task: { state: 'ready', owner: me, by: me, for: null, needs: [], epoch: 0, claim: null, blocked: null, result: null, reason: null } }))
    },
    mutationFn: async (input) => {
      const { task } = await client.post<{ task: Message }>('/tasks', { channel: input.channel, text: input.text, id: input.id })
      await settle(task, [c.tasks.rows])
    },
  })

  /** Follow a thread, or stop. Follows aren't in the feed: this settles on the write's own answer. */
  const follow = createOptimisticAction<{ thread: string; on: boolean }>({
    onMutate: ({ thread, on }) => {
      const had = c.follows.collection.get(thread)
      if (on && !had) c.follows.collection.insert({ thread, discussion: null, channel: c.threads.collection.get(thread)?.channel ?? '', cause: 'followed', at: new Date().toISOString() })
      if (!on && had) c.follows.collection.delete(thread)
    },
    mutationFn: async ({ thread, on }) => {
      const answer = await client.post<{ following: boolean; thread: string; discussion: string | null }>('/messages/' + thread + '/follow', { on })
      const row: Follow = { thread: answer.thread, discussion: answer.discussion, channel: c.threads.collection.get(thread)?.channel ?? '', cause: 'followed', at: new Date().toISOString() }
      if (answer.following) c.follows.rows.apply([row])
      else c.follows.rows.apply([], [answer.thread])
    },
  })

  /**
   * A doc. `re` makes it a task's doc (POST /docs {re}, which step 2 adds to the framework); until
   * then the board refuses it, and the write rolls back.
   */
  const createDoc = async (input: { channel: string; slug: string; body: string; re?: string }) => {
    const { message } = await client.post<{ message: Message }>('/docs', input)
    await settle(message, [c.messages.rows])
    return message
  }

  return { post, edit, createTask, follow, createDoc }
}

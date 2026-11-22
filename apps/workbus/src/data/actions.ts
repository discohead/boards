// Writes, each optimistic: it shows at once, and settles when the feed brings the board's own
// event for it back (a post's answer says which: its message's `version` is that event's cursor;
// an edit's is the next message.edited for it). A refusal rolls it back. Each write carries a client ID (`id`), so sending it again
// after a lost answer posts it once.
import { safeRandomUUID, type DbClient, type Transaction } from '@tanstack/db'
import type { BusCollections } from './index.ts'
import type { BusRuntime } from './runtime.ts'
import type { Follow, Message } from './types.ts'

/** How long a write waits for its echo before it takes its own answer as the row. */
const ECHO_MS = 10_000

/** An optimistic write on db: onMutate's changes show at once; mutationFn persists them, then waits for the echo. */
const action = <V>(db: DbClient, options: { onMutate: (input: V) => void; mutationFn: (input: V) => Promise<void> }) => (input: V): Transaction => {
  const transaction = db.createTransaction({ mutationFn: () => options.mutationFn(input) })
  transaction.mutate(() => options.onMutate(input))
  return transaction
}

export function busActions(db: DbClient, runtime: BusRuntime, c: BusCollections) {
  const { client } = runtime
  const feed = runtime.feed!
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
      const { message } = await client.post<{ message: Message }>('/messages', input.re ? { re: input.re, text: input.text, id: input.id } : { channel: input.channel, text: input.text, id: input.id })
      await settle(message, [c.messages.utils.rows])
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
        c.messages.utils.rows.merge([message], (row) => row.version)
      }
    },
  })

  const createTask = action<{ channel: string; text: string; id?: string }>(db, {
    onMutate: (input) => {
      const id = (input.id ??= 'web-' + safeRandomUUID())
      const me = runtime.me.actor
      c.tasks.insert(draft({ id, channel: input.channel, text: input.text, labels: { 'board.task': 'ready' }, task: { state: 'ready', owner: me, by: me, for: null, needs: [], epoch: 0, claim: null, blocked: null, result: null, reason: null } }))
    },
    mutationFn: async (input) => {
      const { task } = await client.post<{ task: Message }>('/tasks', { channel: input.channel, text: input.text, id: input.id })
      await settle(task, [c.tasks.utils.rows])
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
    const { message } = await client.post<{ message: Message }>('/docs', input)
    await settle(message, [c.messages.utils.rows])
    return message
  }

  return { post, edit, createTask, follow, createDoc }
}

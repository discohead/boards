// Writes on messages and channels beyond actions.ts: delete, react, a new channel, and a thread that
// gains a body ("write it up"). Each shows at once and settles on the board's own event for it
// (settle.ts); a refusal rolls it back. Making a thread a task and assigning it are the C and A
// shortcuts' (shortcut-actions.ts); task verbs are task-actions.ts's.
import type { DbClient } from '@tanstack/db'
import { action, sendAndSettle } from './settle.ts'
import type { BusCollections } from './index.ts'
import type { BusRuntime } from './runtime.ts'
import type { Channel, Message } from './types.ts'

export function threadActions(db: DbClient, runtime: BusRuntime, c: BusCollections) {
  const { client } = runtime
  const feed = () => runtime.feed!
  /** After ECHO_MS without the echo: read the message again. */
  const reread = (id: string) => async () => {
    const { message } = await client.get<{ message: Message }>('/messages/' + id + '?limit=1')
    c.messages.utils.rows.merge([message], (row) => row.version)
  }
  /** Change a message where it's shown: messages, and the threads list when it's a root. */
  const patch = (id: string, change: (message: Message) => void) => {
    if (c.messages.has(id)) c.messages.update(id, change)
    if (c.threads.has(id)) c.threads.update(id, (thread) => change(thread.root))
  }

  /** Delete a message (one's own, or any with manage). */
  const remove = action<{ id: string }>(db, {
    onMutate: ({ id }) =>
      patch(id, (message) => {
        message.deleted = true
        message.text = ''
      }),
    mutationFn: async ({ id }) => {
      await sendAndSettle(feed(), () => client.post('/messages/' + id + '/delete', {}), { test: (event) => event.type === 'message.deleted' && event.message?.id === id }, reread(id))
    },
  })

  /** Add a reaction, or take one's own away. */
  const react = action<{ id: string; emoji: string; remove?: boolean }>(db, {
    onMutate: (input) => {
      const me = runtime.me.actor
      patch(input.id, (message) => {
        const reactions = message.reactions as Record<string, string[]>
        const by = (reactions[input.emoji] ?? []).filter((actor) => actor !== me)
        if (input.remove) {
          if (by.length) reactions[input.emoji] = by
          else delete reactions[input.emoji]
        } else reactions[input.emoji] = [...by, me]
      })
    },
    mutationFn: async (input) => {
      await sendAndSettle(
        feed(),
        () => client.post('/messages/' + input.id + '/reactions', { emoji: input.emoji, ...(input.remove ? { remove: true } : {}) }),
        { test: (event) => event.type === (input.remove ? 'reaction.removed' : 'reaction.added') && event.message?.id === input.id },
        reread(input.id),
      )
    },
  })

  /** A new channel. Its channel.created event puts it in the sidebar; the answer does too, so it's there to open at once. */
  const createChannel = async (path: string) => {
    const answer = await client.post<{ channel: Channel; created: boolean }>('/channels', { path })
    if (!c.channels.utils.rows.get(answer.channel.path)) c.channels.utils.rows.apply([answer.channel])
    return answer
  }

  /** Give a thread a body (POST /docs { re }): its root becomes a doc, starting from body or the root's text. */
  const writeUp = action<{ re: string; slug: string; body?: string }>(db, {
    onMutate: () => {},
    mutationFn: async (input) => {
      await sendAndSettle(
        feed(),
        () => client.post<{ message: Message }>('/docs', { re: input.re, slug: input.slug, ...(input.body !== undefined ? { body: input.body } : {}) }),
        { test: (event) => event.message?.id === input.re && event.message.doc !== undefined },
        (answer) => c.messages.utils.rows.merge([answer.message], (row) => row.version),
      )
    },
  })

  return { remove, react, createChannel, writeUp }
}

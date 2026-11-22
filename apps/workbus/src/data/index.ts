// The data layer (design/workbus.md §9.2): one bus client, one live feed, the collections, and the
// writes. In the browser it's createBus({ url: '/b/bus' }), with the Access cookie; in wrangler dev
// or a script, pass a token too.
import { BusClient, BusRefusal, type BusOptions } from './client.ts'
import { Feed } from './feed.ts'
import { busCollections } from './collections.ts'
import { busActions } from './actions.ts'
import type { Message, DocBody } from './types.ts'

export { BusClient, BusRefusal, Feed }
export type * from './types.ts'

export function createBus(options: BusOptions) {
  const client = new BusClient(options)
  const feed = new Feed(client)
  const collections = busCollections(client, feed)
  const actions = busActions(client, feed, collections)
  const ready = (async () => {
    collections.me.actor = (await client.get<{ actor: string }>('/me')).actor
  })()

  /** A thread's replies, when it's opened: up to 500, merged where they're no older than what the feed brought. */
  const openThread = async (id: string) => {
    const page = await client.get<{ message: Message; replies: Message[] }>('/messages/' + id + '?limit=500')
    collections.messages.rows.merge([page.message, ...page.replies], (row) => row.version)
    return page
  }

  /** A doc's body, when it's opened; doc.edited events keep it current from then on. */
  const openDoc = async (id: string) => {
    const page = await client.get<{ doc: { revision: string }; body: string }>('/docs/' + id)
    const had = collections.bodies.rows.get(id)
    if (!had || Number(had.revision) <= Number(page.doc.revision)) collections.bodies.rows.apply([{ id, revision: page.doc.revision, body: page.body } satisfies DocBody])
    return page
  }

  return { client, feed, ...collections, actions, ready, openThread, openDoc, close: () => feed.close() }
}

export type Bus = ReturnType<typeof createBus>

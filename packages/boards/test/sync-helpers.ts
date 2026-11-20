// What the sync tests share: a webhook from the suite's platform (test/sync-provider.ts), the
// board's Inbox for it, and the thread a platform root came in as.
import { env, runInDurableObject, SELF } from 'cloudflare:test'
import { expect } from 'vitest'
import { api, boardUrl, until } from './helpers.ts'
import { imported, sent, type TestEvent } from './sync-provider.ts'

export const KEY = 'test'

/** A webhook from the platform, signed unless it says otherwise. */
export async function webhook(name: string, events: (TestEvent & { id: string })[], signature = 'good') {
  const response = await SELF.fetch(boardUrl(name) + '/webhooks/' + KEY, { method: 'POST', headers: { 'content-type': 'application/json', 'x-test-signature': signature }, body: JSON.stringify({ board: name, events }) })
  return { status: response.status, text: await response.text() }
}

/** The rows of the board's Inbox for the key, read inside it. */
export const inboxRows = (name: string) =>
  runInDurableObject(env.INBOX.getByName('inbox:' + name + ':' + KEY), (_instance, state) => state.storage.sql.exec('select id, thread, state, attempts, error, raw from events order by n').toArray() as { id: string; thread: string; state: string; attempts: number; error: string | null; raw: string | null }[])

export const importsOf = (name: string) => imported.filter((entry) => entry.board === name)
export const sentOf = (name: string) => sent.filter((entry) => entry.board === name)

/** A platform root, imported: its board message ID. */
export async function platformRoot(name: string, thread = 't1', text = 'a platform thread') {
  expect((await webhook(name, [{ id: 'root-' + thread, kind: 'root', thread, message: 'm0', channel: 'synced', text }])).status).toBe(200)
  const found = await until(async () => (await api(name, 'GET', '/sync/find?thread=' + encodeURIComponent(KEY + ':' + name + ':' + thread))).body.thread, 'the platform root')
  return (await api(name, 'GET', '/sync/threads/' + encodeURIComponent(found))).body.root as string
}

export const reply = async (name: string, re: string, text: string) => {
  const posted = await api(name, 'POST', '/messages', { re, text })
  expect(posted.status).toBe(201)
  return posted.body.message.id as string
}


// The courier: the Mailbox of the @sync:<key> subscription. What's written on the board in a thread
// synced with a target of the key goes to the platform once (the receipt is the retry guard), the
// platform's echo of it isn't imported again, a post that fails 5 times is recorded as
// message.sync_failed and the thread goes on, and an edit that fails never holds the thread.
import { describe, expect, it } from 'vitest'
import { api, freshBoard, until } from './helpers.ts'
import { KEY, platformRoot, reply, sentOf, webhook } from './sync-helpers.ts'

const posts = (name: string, id: string) => sentOf(name).filter((entry) => entry.op === 'post' && entry.message === id)
const settle = (ms = 600) => new Promise((resolve) => setTimeout(resolve, ms))
const syncOf = async (name: string, id: string) => (await api(name, 'GET', '/messages/' + id + '/sync')).body.targets as { target: string; message: string | null; undelivered: string | null }[]

describe('the courier', () => {
  it('posts each board reply in a synced thread once, records its receipt, and never posts the import', async () => {
    const name = freshBoard('courier-once')
    const root = await platformRoot(name)
    const id = await reply(name, root, 'from the board')
    await until(() => posts(name, id).some((entry) => entry.ok), 'the post')
    await settle()
    expect(posts(name, id)).toHaveLength(1)
    expect(posts(name, id)[0]).toMatchObject({ target: KEY + ':' + name + ':t1', thread: KEY + ':' + name + ':t1', text: 'from the board' })
    expect(await syncOf(name, id)).toEqual([expect.objectContaining({ target: KEY + ':' + name + ':t1', message: posts(name, id)[0]!.copy, undelivered: null })])
    expect(posts(name, root)).toEqual([])
  })

  it("doesn't import the platform's echo of a copy", async () => {
    const name = freshBoard('courier-echo')
    const root = await platformRoot(name)
    const id = await reply(name, root, 'said on the board')
    const copy = (await until(() => posts(name, id).find((entry) => entry.ok), 'the post')).copy!
    await until(async () => (await syncOf(name, id))[0]?.message === copy, 'the receipt')
    expect((await webhook(name, [{ id: 'echo-' + copy, kind: 'reply', thread: 't1', message: copy, text: 'said on the board' }])).status).toBe(200)
    await until(async () => (await api(name, 'GET', '/inbox/' + KEY)).body.events.some((event: { id: string; state: string }) => event.id === 'echo-' + copy && event.state === 'done'), 'the echo, drained')
    const thread = await api(name, 'GET', '/messages/' + root)
    expect(thread.body.replies.map((message: { id: string; text: string }) => [message.id, message.text])).toEqual([[id, 'said on the board']])
  })

  it('on a retry, posts only what has no copy yet: the receipt is the guard', async () => {
    const name = freshBoard('courier-guard')
    const root = await platformRoot(name)
    expect((await api(name, 'POST', '/messages/' + root + '/sync', { target: KEY + ':' + name + ':second' })).status).toBe(200)
    // Each target refuses its first try: the first try fails at the first target, the second at the second.
    const id = await reply(name, root, 'two targets fail-post-1')
    await until(async () => (await syncOf(name, id)).every((entry) => entry.message), 'both receipts', 15_000)
    await settle(1500)
    // One target's try fails, then it lands; the next try fails at the other target, and the first isn't posted again.
    const tries = posts(name, id).map((entry) => entry.target.split(':')[2] + (entry.ok ? '' : '!'))
    const [first, second] = [tries[0]!.replace('!', ''), tries[2]!.replace('!', '')]
    expect(new Set([first, second])).toEqual(new Set(['t1', 'second']))
    expect(tries).toEqual([first + '!', first, second + '!', second])
    expect((await syncOf(name, id)).map((entry) => [entry.target.split(':')[2], Boolean(entry.message)])).toEqual([['t1', true], ['second', true]])
  })

  it('records message.sync_failed after 5 failed deliveries, and the thread goes on', async () => {
    const name = freshBoard('courier-fails')
    const root = await platformRoot(name)
    const failing = await reply(name, root, 'never goes fail-post-always')
    const next = await reply(name, root, 'goes after it')
    await until(() => posts(name, next).some((entry) => entry.ok), 'the next post', 25_000)
    expect(posts(name, failing).map((entry) => entry.ok)).toEqual([false, false, false, false, false])
    expect(posts(name, next)[0]!.at).toBeGreaterThan(posts(name, failing)[4]!.at)
    const [target] = await syncOf(name, failing)
    expect(target).toMatchObject({ message: null, undelivered: 'the platform failed post (try 5)' })
    const { body } = await api(name, 'GET', '/events?all=true&last=50')
    expect(body.events.filter((event: { type: string }) => event.type === 'message.sync_failed').map((event: { payload: { id: string } }) => event.payload.id)).toEqual([failing])
  })

  it("an edit that fails is tried once and doesn't hold the thread", async () => {
    const name = freshBoard('courier-edit')
    const root = await platformRoot(name)
    const id = await reply(name, root, 'first')
    await until(async () => (await syncOf(name, id))[0]?.message, 'the receipt')
    expect((await api(name, 'POST', '/messages/' + id + '/edit', { text: 'first, edited fail-edit' })).status).toBe(200)
    const next = await reply(name, root, 'second')
    await until(() => posts(name, next).some((entry) => entry.ok), 'the next post')
    await settle(1500)
    const edits = sentOf(name).filter((entry) => entry.op === 'edit')
    expect(edits.map((entry) => [entry.text, entry.ok])).toEqual([['first, edited fail-edit', false]])
    // Not held for a retry: the next post came right after the edit's one try.
    expect(posts(name, next)[0]!.at - edits[0]!.at).toBeLessThan(900)
  })

  it('shows typing on the thread' + "'" + 's targets and writes nothing', async () => {
    const name = freshBoard('courier-typing')
    const root = await platformRoot(name)
    const before = (await api(name, 'GET', '/events?all=true&last=100')).body.events.length
    const typing = await api(name, 'POST', '/messages/' + root + '/typing', { status: 'thinking' })
    expect(typing).toEqual({ status: 200, body: { targets: [KEY + ':' + name + ':t1'] } })
    expect(sentOf(name).filter((entry) => entry.op === 'typing').map((entry) => [entry.thread, entry.text])).toEqual([[KEY + ':' + name + ':t1', 'thinking']])
    expect((await api(name, 'GET', '/events?all=true&last=100')).body.events.length).toBe(before)
  })

  it("is the board's own sync: discovery lists it, and only its satellites import under its key", async () => {
    const name = freshBoard('courier-own')
    const discovery = await api(name, 'GET', '/')
    expect(discovery.body.sync).toEqual([{ key: KEY, platform: 'test' }])
    const forged = await api(name, 'POST', '/sync/imports', { op: 'post', from: KEY, author: { id: KEY + ':user:u9', handle: 'mallory', name: 'Mallory', avatar: null, isBot: false }, channel: 'synced', text: 'forged provenance' })
    expect(forged.status).toBe(403)
    expect((await api(name, 'POST', '/watchers', { watch: {}, sync: [{ key: KEY, platform: 'test' }] })).body.error.code).toBe('sync_key_taken')
  })
})

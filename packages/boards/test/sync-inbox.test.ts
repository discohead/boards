// The Inbox: a platform's webhook is verified by the sync's provider and kept in inbox:<board>:<key>
// before the platform hears 200; its alarm imports each event through the Ledger, one platform thread
// at a time and in order, 5 tries 1 second apart and doubling, then failed so the thread goes on.
import { abortAllDurableObjects } from 'cloudflare:test'
import { describe, expect, it } from 'vitest'
import { api, freshBoard, until } from './helpers.ts'
import { importsOf, inboxRows, KEY, webhook } from './sync-helpers.ts'

describe('the Inbox', () => {
  it("keeps a webhook's events before it answers 200, and they outlive it", async () => {
    const name = freshBoard('inbox-durable')
    expect(await webhook(name, [{ id: 'e1', kind: 'root', thread: 't1', message: 'm1', channel: 'synced', text: 'hello' }])).toEqual({ status: 200, text: 'kept 1\n' })
    const rows = await inboxRows(name)
    expect(rows.map((row) => row.id)).toEqual(['e1'])
    expect(JSON.parse(rows[0]!.raw!)).toEqual({ delivered: { id: 'e1', kind: 'root', thread: 't1', message: 'm1', channel: 'synced', text: 'hello' } })

    await abortAllDurableObjects()
    expect((await inboxRows(name)).map((row) => row.id)).toEqual(['e1'])
    await until(async () => (await api(name, 'GET', '/sync/find?thread=' + encodeURIComponent(KEY + ':' + name + ':t1'))).body.thread, 'the import')
  })

  it("answers no 200 for what it couldn't keep, nor for a forged webhook", async () => {
    const name = freshBoard('inbox-refused')
    const refused = await webhook(name, [{ id: 'x'.repeat(301), kind: 'root', thread: 't1', message: 'm1', channel: 'synced', text: 'hello' }])
    expect(refused.status).toBe(500)
    expect(await inboxRows(name)).toEqual([])
    expect(await webhook(name, [{ id: 'e1', kind: 'root', thread: 't1', message: 'm1', channel: 'synced', text: 'hello' }], 'forged')).toEqual({ status: 401, text: 'not signed\n' })
    expect(await inboxRows(name)).toEqual([])
  })

  it('a retry of a webhook does nothing', async () => {
    const name = freshBoard('inbox-retry')
    const events = [{ id: 'e1', kind: 'root' as const, thread: 't1', message: 'm1', channel: 'synced', text: 'once' }]
    expect((await webhook(name, events)).status).toBe(200)
    await until(() => importsOf(name).length === 1, 'the import')
    expect((await webhook(name, events)).status).toBe(200)
    await new Promise((resolve) => setTimeout(resolve, 500))
    expect(importsOf(name)).toHaveLength(1)
    expect((await inboxRows(name)).map((row) => [row.id, row.state])).toEqual([['e1', 'done']])
    const { body } = await api(name, 'GET', '/messages?channel=synced')
    expect(body.messages.map((message: { text: string }) => message.text)).toEqual(['once'])
  })

  it('imports one platform thread at a time, in order, while other threads go on', async () => {
    const name = freshBoard('inbox-lanes')
    expect(
      (await webhook(name, [
        { id: 'a1', kind: 'flaky', thread: 'a', message: 'a1', fails: 2 },
        { id: 'a2', kind: 'flaky', thread: 'a', message: 'a2', fails: 0 },
        { id: 'b1', kind: 'flaky', thread: 'b', message: 'b1', fails: 0 },
      ])).status,
    ).toBe(200)
    await until(() => importsOf(name).filter((entry) => entry.ok).length === 3, 'three imports', 20_000)
    const tries = importsOf(name).map((entry) => entry.id + (entry.ok ? '' : '!'))
    expect(tries.filter((id) => id.startsWith('a'))).toEqual(['a1!', 'a1!', 'a1', 'a2'])
    // b's lane didn't wait for a's retries.
    expect(tries.indexOf('b1')).toBeLessThan(tries.indexOf('a1'))
  })

  it('gives an event 5 tries, 1 second apart and doubling, then records it failed and its thread goes on', async () => {
    const name = freshBoard('inbox-fails')
    expect((await webhook(name, [{ id: 'x1', kind: 'flaky', thread: 'x', message: 'x1', fails: 99 }, { id: 'x2', kind: 'flaky', thread: 'x', message: 'x2', fails: 0 }])).status).toBe(200)
    await until(() => importsOf(name).some((entry) => entry.id === 'x2'), 'the next event in the thread', 25_000)
    const x1 = importsOf(name).filter((entry) => entry.id === 'x1')
    expect(x1.map((entry) => entry.attempt)).toEqual([1, 2, 3, 4, 5])
    const gaps = x1.slice(1).map((entry, i) => entry.at - x1[i]!.at)
    for (const [i, wanted] of [1000, 2000, 4000, 8000].entries()) {
      expect(gaps[i]).toBeGreaterThanOrEqual(wanted - 50)
      expect(gaps[i]).toBeLessThan(wanted + 1500)
    }
    const rows = await inboxRows(name)
    expect(rows.map((row) => [row.id, row.state, row.attempts])).toEqual([['x1', 'failed', 5], ['x2', 'done', 1]])
    expect(rows[0]!.error).toBe('flaky import, try 5')
  })

  it('replays a failed event with 5 fresh tries, for someone who manages the board', async () => {
    const name = freshBoard('inbox-replay')
    // Fails 5 times, then would succeed: a deploy's rollout, say.
    expect((await webhook(name, [{ id: 'r1', kind: 'flaky', thread: 'r', message: 'r1', fails: 5 }])).status).toBe(200)
    await until(async () => (await inboxRows(name))[0]?.state === 'failed', 'the event failed', 25_000)
    const narrowed = await api(name, 'POST', '/inbox/' + KEY + '/replay', {}, { 'x-board-can': '*=read,post' })
    expect(narrowed.status).toBe(403)
    expect((await inboxRows(name))[0]?.state).toBe('failed')
    const replayed = await api(name, 'POST', '/inbox/' + KEY + '/replay', {})
    expect(replayed.body).toEqual({ replayed: 1 })
    await until(async () => (await inboxRows(name))[0]?.state === 'done', 'the replayed import')
    expect(importsOf(name).filter((entry) => entry.id === 'r1' && entry.ok)).toHaveLength(1)
  })
})

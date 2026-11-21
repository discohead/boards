// The outbox and watchers: the Ledger hands each matching event to its watcher's Mailbox, which
// delivers it to the watcher's sink (test/sink.ts) once, in order per thread, retrying a sink that
// fails with a growing wait. Everything here runs on the wall clock: the Mailbox's real alarms.
import { evictDurableObject } from 'cloudflare:test'
import { describe, expect, it } from 'vitest'
import { api, freshBoard, ledgerOf, until } from './helpers.ts'
import { deliveredTo, type Delivery } from './sink.ts'
import { lateWatchers } from './worker.ts'

const ok = (entries: Delivery[]) => entries.filter((entry) => entry.ok)
const texts = (entries: Delivery[]) => entries.map((entry) => entry.event.message?.text)
const post = async (name: string, body: Record<string, unknown>) => {
  const posted = await api(name, 'POST', '/messages', body)
  expect(posted.status).toBe(201)
  return posted.body.message.id as string
}

describe('watchers', () => {
  it('the first message on a brand-new board is delivered', async () => {
    const name = freshBoard('first')
    const id = await post(name, { channel: 'general', text: 'the very first write' })

    await until(() => ok(deliveredTo(name, 'everything')).length > 0, 'the first delivery')
    const [first] = ok(deliveredTo(name, 'everything'))
    expect(first!.event).toMatchObject({ type: 'message.posted', message: { id, text: 'the very first write' } })
  })

  it('a watcher gets each matching event once, in order per thread', async () => {
    const name = freshBoard('order')
    const root = await post(name, { channel: 'general', text: 'root' })
    for (const text of ['one', 'two', 'three']) await post(name, { re: root, text })
    expect((await api(name, 'POST', '/messages/' + root + '/reactions', { emoji: 'eyes' })).status).toBe(200)
    // A burst of writes at once, so the Ledger hands them on while it's still handing on the last.
    const burst = await Promise.all(Array.from({ length: 8 }, (_, i) => post(name, { channel: 'random', text: 'burst ' + i })))

    await until(() => ok(deliveredTo(name, 'everything')).length >= 13, 'thirteen deliveries')
    await new Promise((resolve) => setTimeout(resolve, 300))
    const delivered = ok(deliveredTo(name, 'everything'))
    expect(delivered).toHaveLength(13)
    expect(new Set(delivered.map((entry) => entry.event.cursor)).size).toBe(13)
    expect(deliveredTo(name, 'everything')).toHaveLength(13)
    const thread = delivered.filter((entry) => entry.event.message?.id === root || entry.event.message?.re === root)
    expect(thread.map((entry) => [entry.event.type, entry.event.message?.text])).toEqual([
      ['message.posted', 'root'],
      ['message.posted', 'one'],
      ['message.posted', 'two'],
      ['message.posted', 'three'],
      ['reaction.added', 'root'],
    ])
    expect(thread.map((entry) => Number(entry.event.cursor))).toEqual([...thread.map((entry) => Number(entry.event.cursor))].sort((a, b) => a - b))
    expect(delivered.filter((entry) => entry.event.message?.channel === 'random').map((entry) => entry.event.message?.id).sort()).toEqual([...burst].sort())
  })

  it('a failing sink is retried with backoff, its thread waits, and other threads go on', async () => {
    const name = freshBoard('flaky')
    const root = await post(name, { channel: 'flaky', text: 'fail-twice: the root' })
    await post(name, { re: root, text: 'first reply' })
    await post(name, { re: root, text: 'second reply' })
    await post(name, { channel: 'flaky', text: 'another thread' })
    await post(name, { channel: 'general', text: 'not this watcher' })

    await until(() => ok(deliveredTo(name, 'flaky')).length >= 4, 'four deliveries', 20_000)
    const tries = deliveredTo(name, 'flaky')
    const rootTries = tries.filter((entry) => entry.event.message?.id === root)
    expect(rootTries.map((entry) => [entry.attempt, entry.ok])).toEqual([[1, false], [2, false], [3, true]])
    expect(rootTries[1]!.at - rootTries[0]!.at).toBeGreaterThanOrEqual(950)
    expect(rootTries[2]!.at - rootTries[1]!.at).toBeGreaterThanOrEqual(1950)

    const delivered = ok(tries)
    expect(texts(delivered)).toHaveLength(4)
    expect(texts(delivered)).not.toContain('not this watcher')
    const at = (text: string) => delivered.find((entry) => entry.event.message?.text === text)!.at
    expect(at('first reply')).toBeGreaterThanOrEqual(rootTries[2]!.at)
    expect(at('second reply')).toBeGreaterThanOrEqual(at('first reply'))
    expect(tries.filter((entry) => entry.event.message?.re === root).every((entry) => entry.ok && entry.attempt === 1)).toBe(true)
    expect(at('another thread')).toBeLessThan(rootTries[2]!.at)
  })

  it('a watcher deployed later starts at the head: it misses nothing after, and gets nothing from before', async () => {
    const name = freshBoard('late')
    await post(name, { channel: 'general', text: 'before one' })
    await post(name, { channel: 'general', text: 'before two' })
    await until(() => ok(deliveredTo(name, 'everything')).length >= 2, 'the board in use')

    lateWatchers.late = { tail: '', sink: { kind: 'url', url: 'https://sink.test/late' } }
    try {
      await evictDurableObject(ledgerOf(name) as unknown as DurableObjectStub)
      await post(name, { channel: 'general', text: 'after one' })
      await post(name, { channel: 'general', text: 'after two' })

      await until(() => ok(deliveredTo(name, 'late')).length >= 2, 'the late watcher')
      await new Promise((resolve) => setTimeout(resolve, 300))
      expect(texts(ok(deliveredTo(name, 'late')))).toEqual(['after one', 'after two'])
      expect(texts(ok(deliveredTo(name, 'everything')))).toEqual(['before one', 'before two', 'after one', 'after two'])
    } finally {
      delete lateWatchers.late
    }
  })
})

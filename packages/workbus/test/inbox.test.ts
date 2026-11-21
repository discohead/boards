// The inbox: what a platform pushes (a webhook) is kept on the board before the push is answered, then
// pulled one lease per thread, in the order it came, until it's acked.
import { abortAllDurableObjects } from 'cloudflare:test'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { api, clock, freshBoard } from './helpers.ts'

const KEY = 'gh'
const author = { id: '7', handle: 'octo', name: 'Octo', avatar: null, isBot: false }
const event = (thread: string, message: string) => ({
  id: 'delivery-' + message,
  event: { kind: 'message', channel: KEY + ':acme/web', thread: KEY + ':acme/web#' + thread, subthread: null, message, isRoot: false, text: 'comment ' + message, context: null, author },
  raw: { delivery: message },
})
type Item = { id: string; lease: string; thread: string; attempt: number; event: { message: string } }
const next = async (name: string) => (await api(name, 'GET', '/inbox/' + KEY + '/next')).body.items as Item[]
const ack = (name: string, item: Item, extra: Record<string, unknown> = {}) => api(name, 'POST', '/inbox/' + KEY + '/' + encodeURIComponent(item.id) + '/ack', { lease: item.lease, ...extra })
const messages = (items: Item[]) => items.map((item) => item.event.message)

let time: ReturnType<typeof clock>
beforeEach(() => void (time = clock()))
afterEach(() => time.restore())

describe('the inbox', () => {
  it('a pushed event is durable before the push is answered: it outlives the Ledger that took it', async () => {
    const name = freshBoard('inbox-durable')
    const pushed = await api(name, 'POST', '/inbox/' + KEY, { events: [event('1', 'a1')] })
    expect(pushed).toEqual({ status: 200, body: { ok: true } })

    await abortAllDurableObjects()

    expect(messages(await next(name))).toEqual(['a1'])
  })

  it('a push delivered twice is kept once', async () => {
    const name = freshBoard('inbox-once')
    await api(name, 'POST', '/inbox/' + KEY, { events: [event('1', 'a1')] })
    await api(name, 'POST', '/inbox/' + KEY, { events: [event('1', 'a1')] })
    const [item] = await next(name)
    expect((await ack(name, item!)).status).toBe(200)
    expect(await next(name)).toEqual([])
  })

  it('one lease per thread, in order: a thread\'s next event waits for the one before it', async () => {
    const name = freshBoard('inbox-order')
    expect((await api(name, 'POST', '/inbox/' + KEY, { events: [event('1', 'a1'), event('2', 'b1'), event('1', 'a2'), event('1', 'a3')] })).status).toBe(200)

    const first = await next(name)
    expect(messages(first)).toEqual(['a1', 'b1'])
    expect(await next(name)).toEqual([])

    const a1 = first.find((item) => item.event.message === 'a1')!
    expect((await ack(name, a1)).status).toBe(200)
    expect(messages(await next(name))).toEqual(['a2'])
    expect(await next(name)).toEqual([])
  })

  it('an ack with an error gives the event back after a backoff, and a stale lease is refused', async () => {
    const name = freshBoard('inbox-retry')
    await api(name, 'POST', '/inbox/' + KEY, { events: [event('1', 'a1'), event('1', 'a2')] })
    const [a1] = await next(name)
    expect((await ack(name, a1!, { error: 'the platform was down' })).status).toBe(200)
    expect(await next(name)).toEqual([])

    time.advance(1_100)
    const [again] = await next(name)
    expect(again).toMatchObject({ id: a1!.id, attempt: 1 })
    expect(again!.lease).not.toBe(a1!.lease)
    const stale = await ack(name, a1!)
    expect(stale.status).toBe(409)
    expect(stale.body.error.code).toBe('stale_lease')
    expect((await ack(name, again!)).status).toBe(200)
    expect(messages(await next(name))).toEqual(['a2'])
  })
})

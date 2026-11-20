// Held waits: a long-poll is held by the Gateway and woken by the board's Relay, which the Ledger
// rings when its log moves. So a wait ends as soon as a matching write lands, not at its timeout.
import { runInDurableObject, SELF } from 'cloudflare:test'
import { describe, expect, it } from 'vitest'
import { api, boardUrl, freshBoard, ledgerOf, tokenFor, until } from './helpers.ts'

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))
const relaysOf = (name: string) => runInDurableObject(ledgerOf(name) as unknown as DurableObjectStub, (_instance, state) => state.storage.kv.get<string[]>('relays') ?? [])

async function held(name: string, method: string, path: string, body?: unknown) {
  const started = Date.now()
  const response = await SELF.fetch(boardUrl(name) + path, {
    method,
    headers: { authorization: 'Bearer ' + (await tokenFor(name)), ...(body ? { 'content-type': 'application/json' } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}),
  })
  return { status: response.status, body: (await response.json()) as any, at: Date.now(), took: Date.now() - started }
}

describe('held waits', () => {
  it('a long-poll for events returns as soon as a matching write lands, woken by the Relay', async () => {
    const name = freshBoard('poll')
    const start = await api(name, 'GET', '/events?channel=deploys')
    expect(start.body.events).toEqual([])

    const waiting = held(name, 'GET', '/events?channel=deploys&wait=10&after=' + start.body.cursor)
    await until(async () => (await relaysOf(name)).length > 0, 'the wait to attach a Relay')
    await sleep(300)
    await api(name, 'POST', '/messages', { channel: 'general', text: 'not what it waits for' })
    await sleep(300)
    const wrote = Date.now()
    await api(name, 'POST', '/messages', { channel: 'deploys', text: 'v42 is out' })
    const answer = await waiting

    expect(answer.status).toBe(200)
    expect(answer.body.events.map((event: { type: string; message: { text: string } }) => [event.type, event.message.text])).toEqual([['message.posted', 'v42 is out']])
    expect(answer.took).toBeGreaterThanOrEqual(600)
    expect(answer.at - wrote).toBeLessThan(2_000)
  })

  it('a long-poll with nothing to wake it answers at its timeout, empty', async () => {
    const name = freshBoard('quiet')
    const start = await api(name, 'GET', '/events')
    const answer = await held(name, 'GET', '/events?wait=1&after=' + start.body.cursor)
    expect(answer.status).toBe(200)
    expect(answer.body.events).toEqual([])
    expect(answer.took).toBeGreaterThanOrEqual(950)
  })

  it('a claim that waits for a ready task takes one as soon as it is made', async () => {
    const name = freshBoard('claim-wait')
    const waiting = held(name, 'POST', '/tasks/claim', { channel: 'work', wait: 10, lease: 60 })
    await until(async () => (await relaysOf(name)).length > 0, 'the wait to attach a Relay')
    await sleep(300)
    const wrote = Date.now()
    const made = await api(name, 'POST', '/tasks', { channel: 'work', text: 'triage the queue' })
    const answer = await waiting

    expect(answer.status).toBe(200)
    expect(answer.body.task).toMatchObject({ id: made.body.task.id, task: { state: 'claimed', epoch: 1 } })
    expect(answer.at - wrote).toBeLessThan(2_000)
  })
})

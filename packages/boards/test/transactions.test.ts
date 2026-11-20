// A write is one transaction: an operation that throws partway leaves nothing behind, and the log's
// positions stay gapless.
import { describe, expect, it } from 'vitest'
import { badRequest } from '../src/errors.ts'
import { postMessage } from '../src/ledger/messages.ts'
import { op } from '../src/ledger/ops.ts'
import { api, freshBoard, headOf, ledgerOf, mountOf, person, rows } from './helpers.ts'

// An operation that writes a whole post (message, thread, channel, terms, events) and then refuses.
op('testPostThenRefuse', (ctx, input: { channel: string; text: string }) => {
  postMessage(ctx, { channel: input.channel, text: input.text })
  throw badRequest('refused after writing', 'test_refused')
})

const counts = async (name: string) => {
  const [counted] = await rows<Record<string, number>>(
    name,
    "select (select count(*) from events) as events, (select count(*) from messages) as messages, (select count(*) from threads) as threads, (select count(*) from channels) as channels, (select count(*) from terms) as terms, (select coalesce(max(seq), 0) from events) as top",
  )
  return counted!
}

describe('a write is one transaction', () => {
  it('an operation that throws midway leaves no rows and the head where it was', async () => {
    const name = freshBoard('txn')
    expect((await api(name, 'POST', '/messages', { channel: 'general', text: 'first #general' })).status).toBe(201)
    const before = await counts(name)
    const head = await headOf(name)

    const answer = await ledgerOf(name).call(person(), 'testPostThenRefuse', { channel: 'elsewhere', text: 'never lands' }, mountOf(name))

    expect(answer).toMatchObject({ ok: false, failure: { status: 400, code: 'test_refused' } })
    expect(await counts(name)).toEqual(before)
    expect(await headOf(name)).toBe(head)
    expect(await rows(name, "select * from messages where text = 'never lands'")).toEqual([])
    expect(await rows(name, "select * from channels where path = 'elsewhere'")).toEqual([])
    const channels = await api(name, 'GET', '/channels')
    expect(channels.body.channels.map((channel: { path: string }) => channel.path)).not.toContain('elsewhere')
  })

  it('seq is gapless across a failed write: the next write takes the position the failed one gave back', async () => {
    const name = freshBoard('gapless')
    expect((await api(name, 'POST', '/messages', { channel: 'general', text: 'one' })).status).toBe(201)
    const head = await headOf(name)

    for (let i = 0; i < 3; i++) expect((await ledgerOf(name).call(person(), 'testPostThenRefuse', { channel: 'general', text: 'no' }, mountOf(name))).ok).toBe(false)
    const posted = await api(name, 'POST', '/messages', { channel: 'general', text: 'two' })

    expect(posted.status).toBe(201)
    expect(Number(posted.body.message.id)).toBe(head + 1)
    const seqs = (await rows<{ seq: number }>(name, 'select seq from events order by seq')).map((row) => row.seq)
    expect(seqs).toEqual(Array.from({ length: seqs.length }, (_, i) => i + 1))
    const feed = await api(name, 'GET', '/events?after=0&all=true')
    expect(feed.body.events.map((event: { cursor: string }) => Number(event.cursor))).toEqual(seqs)
  })
})

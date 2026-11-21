// Idempotency: a client ID lands once however often it's sent, and replies that race on after=
// let exactly one through.
import { describe, expect, it } from 'vitest'
import { api, freshBoard, rows } from './helpers.ts'

describe('idempotency', () => {
  it('the same client ID posted twice lands once, and both answers are that message', async () => {
    const name = freshBoard('idem')
    const body = { channel: 'general', text: 'deploy finished', id: 'ci-run-41' }

    const first = await api(name, 'POST', '/messages', body)
    const second = await api(name, 'POST', '/messages', body)

    expect(first.status).toBe(201)
    expect(second.status).toBe(201)
    expect(second.body.message.id).toBe(first.body.message.id)
    const listed = await api(name, 'GET', '/messages?channel=general')
    expect(listed.body.messages.filter((message: { text: string }) => message.text === 'deploy finished')).toHaveLength(1)
    expect(await rows(name, "select seq from events where type = 'message.posted'")).toHaveLength(1)
  })

  it('the same client ID posted concurrently lands once', async () => {
    const name = freshBoard('idem-race')
    const body = { channel: 'general', text: 'once', id: 'retry-storm' }

    const answers = await Promise.all(Array.from({ length: 5 }, () => api(name, 'POST', '/messages', body)))

    expect(answers.map((answer) => answer.status)).toEqual([201, 201, 201, 201, 201])
    expect(new Set(answers.map((answer) => answer.body.message.id)).size).toBe(1)
    expect(await rows(name, "select id from messages where text = 'once'")).toHaveLength(1)
  })

  it('replies that race with after= the same message: exactly one wins, the other is newer_message', async () => {
    const name = freshBoard('after-race')
    const root = await api(name, 'POST', '/messages', { channel: 'general', text: 'who takes this?' })
    const id = root.body.message.id

    const answers = await Promise.all([
      api(name, 'POST', '/messages', { re: id, text: 'I will', after: id }),
      api(name, 'POST', '/messages', { re: id, text: 'no, I will', after: id }),
    ])

    expect(answers.map((answer) => answer.status).sort()).toEqual([201, 409])
    const loser = answers.find((answer) => answer.status === 409)!
    const winner = answers.find((answer) => answer.status === 201)!
    expect(loser.body.error.code).toBe('newer_message')
    expect(loser.body.error.message).toContain('#' + winner.body.message.id)
    const thread = await api(name, 'GET', '/messages/' + id)
    expect(thread.body.replies.map((reply: { text: string }) => reply.text)).toEqual([winner.body.message.text])
  })
})

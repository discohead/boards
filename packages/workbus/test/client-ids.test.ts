// A client settles an optimistic write when the event that carries its client ID comes back
// (design/workbus.md §9.2): every write that takes an id puts it on its message.posted, as clientId.
import { describe, expect, it } from 'vitest'
import { api, freshBoard } from './helpers.ts'

type Event = { type: string; payload: Record<string, unknown>; message?: { id: string } }
const posted = async (name: string) => ((await api(name, 'GET', '/events?after=0')).body.events as Event[]).filter((event) => event.type === 'message.posted')
const ok = async (name: string, method: string, path: string, body: unknown) => {
  const answer = await api(name, method, path, body)
  expect(answer.status, path + ' ' + JSON.stringify(answer.body)).toBeLessThan(300)
  return answer.body
}

describe('client IDs on events', () => {
  it('a root, a reply, a task, and a doc each carry the id they were written with, once', async () => {
    const name = freshBoard('client-ids')
    const root = (await ok(name, 'POST', '/messages', { channel: 'general', text: 'a root', id: 'c-root' })).message.id
    const reply = (await ok(name, 'POST', '/messages', { re: root, text: 'a reply', id: 'c-reply' })).message.id
    const task = (await ok(name, 'POST', '/tasks', { channel: 'work', text: 'a task', id: 'c-task' })).task.id
    const doc = (await ok(name, 'POST', '/docs', { channel: 'docs', slug: 'plan', body: '# Plan\n', id: 'c-doc' })).message.id
    const plain = (await ok(name, 'POST', '/messages', { channel: 'general', text: 'no id' })).message.id
    // A retry with the same id is the same write: no second event.
    await ok(name, 'POST', '/messages', { re: root, text: 'a reply', id: 'c-reply' })
    await ok(name, 'POST', '/messages', { channel: 'general', text: 'a root', id: 'c-root' })
    const events = await posted(name)
    const byMessage = new Map(events.map((event) => [event.message!.id, event.payload.clientId]))
    expect(Object.fromEntries(byMessage)).toEqual({ [root]: 'c-root', [reply]: 'c-reply', [task]: 'c-task', [doc]: 'c-doc', [plain]: undefined })
    expect(events.length).toBe(5)
  })

  it("a batch's tasks carry the batch's id and each one's place in it", async () => {
    const name = freshBoard('client-ids-batch')
    const made = await ok(name, 'POST', '/tasks/batch', { channel: 'work', id: 'c-batch', tasks: [{ key: 'build', text: 'build' }, { text: 'ship', needs: [{ key: 'build' }] }] })
    await ok(name, 'POST', '/tasks/batch', { channel: 'work', id: 'c-batch', tasks: [{ key: 'build', text: 'build' }, { text: 'ship', needs: [{ key: 'build' }] }] })
    const events = await posted(name)
    expect(events.map((event) => [event.message!.id, event.payload.batch])).toEqual([
      [made.tasks[0].id, { id: 'c-batch', index: 0, key: 'build' }],
      [made.tasks[1].id, { id: 'c-batch', index: 1, key: null }],
    ])
  })
})

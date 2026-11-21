// What the courier hands a provider about a synced root besides its messages: label changes, and its
// task's state, as GitHub Projects needs them; never the sync's own label writes; and replies
// still post as before.
import { describe, expect, it } from 'vitest'
import { api, freshBoard, until } from './helpers.ts'
import { KEY, platformRoot, reply, sentOf, webhook } from './sync-helpers.ts'

const settle = (ms = 800) => new Promise((resolve) => setTimeout(resolve, ms))
const of = (name: string, op: string) => sentOf(name).filter((entry) => entry.op === op)

describe("a synced root's labels and task", () => {
  it('reach the provider: a label set on the board, and each task state', async () => {
    const name = freshBoard('courier-roots')
    const root = await platformRoot(name)
    expect((await api(name, 'POST', '/messages/' + root + '/labels', { set: { 'project.roadmap.priority': 'P1' } })).status).toBe(200)
    await until(() => of(name, 'labels').some((entry) => entry.set?.['project.roadmap.priority'] === 'P1'), 'the label change')
    expect((await api(name, 'POST', '/tasks', { re: root })).status).toBe(201)
    const claimed = await api(name, 'POST', '/tasks/' + root + '/claim', {})
    expect(claimed.status, JSON.stringify(claimed.body)).toBe(200)
    await until(() => of(name, 'task').some((entry) => entry.state === 'claimed'), 'the claim')
    expect(of(name, 'task').map((entry) => entry.state)).toEqual(expect.arrayContaining(['ready', 'claimed']))
    // Replies still go as messages.
    const id = await reply(name, root, 'still a message')
    await until(() => sentOf(name).some((entry) => entry.op === 'post' && entry.message === id), 'the reply')
  })

  it("never the sync's own label writes", async () => {
    const name = freshBoard('courier-roots-own')
    const root = await platformRoot(name)
    const found = await api(name, 'GET', '/sync/find?thread=' + encodeURIComponent(KEY + ':' + name + ':t1'))
    expect(found.status).toBe(200)
    expect((await webhook(name, [{ id: 'lab-1', kind: 'labels', thread: 't1', message: 'lab-1', set: { 'project.roadmap.status': 'Todo' } }])).status).toBe(200)
    await until(async () => (await api(name, 'GET', '/messages/' + root)).body.message.labels['project.roadmap.status'] === 'Todo', 'the imported label')
    await settle()
    expect(of(name, 'labels')).toEqual([])
  })
})

// Moderation (#26) and hidden actors (#16). An owner (manage in the channel, as themselves) may delete
// any message there: logged as any delete, saying who and that it was moderation; a thread's root
// takes its replies with it; a task so deleted is canceled, leaves the open lists, and wakes no one
// after. An owner may hide an actor: it leaves GET /actors and mention settling, gives its claimed
// handle up, keeps its author on its past messages, and shows again once it writes.
import { describe, expect, it } from 'vitest'
import { api, freshBoard, tokenFor, until } from './helpers.ts'
import { wokenFor } from './wake.ts'

type Headers = Record<string, string>
const ADA = 'worker:workbus-app+ada'
const bearer = async (name: string, sub: string, claims: Record<string, unknown>, more: Headers = {}): Promise<Headers> => ({ authorization: 'Bearer ' + (await tokenFor(name, sub, { claims })), ...more })
async function callers(name: string) {
  return {
    owner: await bearer(name, 'jared', { role: 'owner' }),
    // A member who may post but not manage in general.
    member: await bearer(name, 'mallory', { role: 'member' }, { 'x-board-can': 'general=read,post,react,label;eng=read,post,react,label' }),
    ownerAsProfile: await bearer(name, 'jared', { role: 'owner' }, { 'x-board-profile': 'helper' }),
    ada: await bearer(name, 'workbus-app', { kind: 'workload' }, { 'x-board-profile': 'ada;name="Ada";handle="ada"' }),
    dana: await bearer(name, 'workbus-app', { kind: 'workload' }, { 'x-board-profile': 'docs;name="Dana";handle="docs"' }),
    dora: await bearer(name, 'workbus-app', { kind: 'workload' }, { 'x-board-profile': 'writer;name="Dora";handle="docs"' }),
  }
}
const post = async (name: string, headers: Headers, body: Record<string, unknown>) => {
  const posted = await api(name, 'POST', '/messages', body, headers)
  expect(posted.status, JSON.stringify(posted.body)).toBe(201)
  return posted.body.message.id as string
}

describe('moderation', () => {
  it("an owner deletes a seat's reply, logged as moderation; a member and an owner's profile can't", async () => {
    const name = freshBoard('moderation')
    const who = await callers(name)
    const root = await post(name, who.owner, { channel: 'general', text: 'a thread' })
    const reply = await post(name, who.ada, { re: root, text: "ada's reply" })
    for (const [whose, headers] of [['a member without manage', who.member], ["the owner's profile", who.ownerAsProfile]] as const) {
      const refused = await api(name, 'POST', '/messages/' + reply + '/delete', {}, headers)
      expect(refused.status, whose).toBe(403)
    }
    const deleted = await api(name, 'POST', '/messages/' + reply + '/delete', {}, who.owner)
    expect(deleted.body).toEqual({ ok: true, deleted: 1 })
    expect((await api(name, 'GET', '/messages/' + root)).body.replies[0]).toMatchObject({ id: reply, deleted: true, text: '' })
    const events = (await api(name, 'GET', '/events?all=true&last=5')).body.events as { type: string; payload: { id: string; by: { actor: string }; moderation?: boolean } }[]
    expect(events.find((event) => event.type === 'message.deleted' && event.payload.id === reply)?.payload).toMatchObject({ by: { actor: 'workbus:user:jared' }, moderation: true })
  })

  it("deleting a seat's root as moderation takes its replies; a task so deleted is canceled, leaves the open lists, and wakes no one after", async () => {
    const name = freshBoard('moderation-thread')
    const who = await callers(name)
    expect((await api(name, 'POST', '/wakes', { key: 'ada', sink: 'wake', rules: { assigned: 'assigned' } }, who.ada)).status).toBe(201)
    // The task is another seat's (dana's), for ada: its root is no one's the owner wrote.
    const task = (await api(name, 'POST', '/tasks', { channel: 'eng', text: 'a test task for ada', for: ADA }, who.dana)).body.task.id as string
    await until(() => wokenFor(name, 'ada').some((entry) => entry.event.type === 'task.created'), 'the assignment')
    const replies = [await post(name, who.ada, { re: task, text: 'working on it' }), await post(name, who.owner, { re: task, text: 'thanks' })]
    await until(() => wokenFor(name, 'ada').some((entry) => entry.event.message?.text === 'thanks'), "the owner's reply")
    await new Promise((resolve) => setTimeout(resolve, 600))
    const before = wokenFor(name, 'ada').length
    const deleted = await api(name, 'POST', '/messages/' + task + '/delete', {}, who.owner)
    expect(deleted.body).toEqual({ ok: true, deleted: 3 })
    const thread = (await api(name, 'GET', '/messages/' + task)).body
    expect([thread.message.deleted, ...thread.replies.map((one: { deleted: boolean }) => one.deleted)]).toEqual([true, true, true])
    expect(thread.message.task.state).toBe('canceled')
    expect((await api(name, 'GET', '/tasks?channel=eng')).body.tasks).toEqual([])
    expect((await api(name, 'GET', '/tasks?channel=eng&state=all')).body.tasks.map((one: { message: { id: string } }) => one.message.id)).not.toContain(task)
    void replies
    // The deletes and the cancel wake no one: nothing for ada after its assignment.
    await new Promise((resolve) => setTimeout(resolve, 800))
    const after = wokenFor(name, 'ada').slice(before)
    expect(after.map((entry) => entry.event.type)).toEqual([])
    // Again is a no-op: nothing left to delete.
    expect((await api(name, 'POST', '/messages/' + task + '/delete', {}, who.owner)).body).toEqual({ ok: true, deleted: 0 })
  })
})

describe('hidden actors', () => {
  it('an owner hides an actor: gone from /actors and mentions, its handle free, its messages keep their author; it shows again once it writes', async () => {
    const name = freshBoard('hidden')
    const who = await callers(name)
    const said = await post(name, who.dana, { channel: 'general', text: 'Dana was here' })
    expect((await api(name, 'POST', '/actors/hide', { actor: 'worker:workbus-app+docs' }, who.member)).status).toBe(403)
    expect((await api(name, 'POST', '/actors/hide', { actor: 'worker:workbus-app+docs' }, who.owner)).body).toMatchObject({ actor: 'worker:workbus-app+docs', hidden: true, handle: 'docs' })
    const ids = async (query = '') => ((await api(name, 'GET', '/actors' + query)).body.actors as { id: string; hidden?: unknown }[]).map((one) => one.id + (one.hidden ? ' (hidden)' : ''))
    expect(await ids()).not.toContain('worker:workbus-app+docs')
    expect(await ids('?hidden=true')).toContain('worker:workbus-app+docs (hidden)')
    // Its past message keeps its author.
    expect((await api(name, 'GET', '/messages/' + said)).body.message.author).toMatchObject({ name: 'Dana', handle: 'docs' })
    // @docs settles to no one while it's hidden, and the handle is free for another seat.
    expect((await api(name, 'POST', '/messages', { channel: 'general', text: 'hi @docs' })).body.mentions[0]).toMatchObject({ actor: null })
    expect((await api(name, 'POST', '/messages', { channel: 'general', text: 'I am Dora' }, who.dora)).status).toBe(201)
    expect((await api(name, 'POST', '/messages', { channel: 'general', text: 'hi @docs' })).body.mentions[0].actor.id).toBe('worker:workbus-app+writer')
    // An event says it.
    const events = (await api(name, 'GET', '/events?all=true&last=10')).body.events as { type: string; payload: { actor: string; hidden: boolean } }[]
    expect(events.some((event) => event.type === 'actor.hidden' && event.payload.actor === 'worker:workbus-app+docs' && event.payload.hidden)).toBe(true)
    // Unhidden, it's listed again; hidden again, it reappears by writing (its old handle now Dora's, it takes another).
    expect((await api(name, 'POST', '/actors/hide', { actor: 'worker:workbus-app+docs', hidden: false }, who.owner)).body.hidden).toBe(false)
    expect(await ids()).toContain('worker:workbus-app+docs')
    await api(name, 'POST', '/actors/hide', { actor: 'worker:workbus-app+docs' }, who.owner)
    const back = await api(name, 'POST', '/messages', { channel: 'general', text: 'Dana again' }, { ...who.dana, 'x-board-profile': 'docs;name="Dana";handle="dana"' })
    expect(back.status).toBe(201)
    expect(await ids()).toContain('worker:workbus-app+docs')
    // You can't hide yourself, or an actor the board doesn't know.
    expect((await api(name, 'POST', '/actors/hide', { actor: 'workbus:user:jared' }, who.owner)).status).toBe(400)
    expect((await api(name, 'POST', '/actors/hide', { actor: 'worker:nobody' }, who.owner)).status).toBe(404)
  })
})

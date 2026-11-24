// Archived channels (issue #15, ledger/channels.ts): an owner archives a channel or a subtree and
// unarchives it, as events. Archived channels leave GET /channels (unless archived=true) and the
// unread counts, refuse posts, hand out no tasks, and wake no one; counts carry live beside
// cumulative; private channels keep their rule.
import { evictDurableObject, runDurableObjectAlarm, runInDurableObject } from 'cloudflare:test'
import { describe, expect, it } from 'vitest'
import { api, clock, freshBoard, ledgerOf, tokenFor, until } from './helpers.ts'
import { wokenFor } from './wake.ts'

type Headers = Record<string, string>
const bearer = async (name: string, sub: string, claims: Record<string, unknown>, more: Headers = {}): Promise<Headers> => ({ authorization: 'Bearer ' + (await tokenFor(name, sub, { claims })), ...more })
async function callers(name: string) {
  return {
    owner: await bearer(name, 'jared', { role: 'owner' }),
    member: await bearer(name, 'mallory', { role: 'member' }),
    ada: await bearer(name, 'workbus-app', { kind: 'workload' }, { 'x-board-profile': 'ada' }),
    app: await bearer(name, 'workbus-app', { kind: 'workload' }),
  }
}
const post = async (name: string, headers: Headers, body: Record<string, unknown>) => {
  const posted = await api(name, 'POST', '/messages', body, headers)
  expect(posted.status).toBe(201)
  return posted.body.message.id as string
}
const paths = async (name: string, headers: Headers, query = '') => (await api(name, 'GET', '/channels' + query, undefined, headers)).body.channels.map((channel: { path: string }) => channel.path)
const settle = () => new Promise((resolve) => setTimeout(resolve, 600))

describe('archived channels', () => {
  it('an owner archives a channel: it leaves the listing, refuses posts, and comes back when unarchived', async () => {
    const name = freshBoard('arch-one')
    const who = await callers(name)
    const root = await post(name, who.owner, { channel: 'tests', text: 'a test thread' })
    await post(name, who.owner, { channel: 'general', text: 'hello' })
    const archived = await api(name, 'POST', '/channels/archive', { path: 'tests' }, who.owner)
    expect(archived.status).toBe(200)
    expect(archived.body).toMatchObject({ archived: { pattern: 'tests', by: 'workbus:user:jared' }, channels: 1, changed: true })
    expect((await api(name, 'POST', '/channels/archive', { path: 'tests' }, who.owner)).body.changed).toBe(false)

    expect(await paths(name, who.owner)).toEqual(['general'])
    const all = (await api(name, 'GET', '/channels?archived=true', undefined, who.owner)).body.channels
    expect(all.map((channel: { path: string }) => channel.path)).toEqual(['general', 'tests'])
    expect(all[1].archived).toMatchObject({ pattern: 'tests', by: 'workbus:user:jared' })
    expect(all[0].archived).toBeUndefined()

    // Posting there is refused, a new thread or a reply; reading and deleting aren't.
    for (const body of [{ channel: 'tests', text: 'more' }, { re: root, text: 'a reply' }]) {
      const refused = await api(name, 'POST', '/messages', body, who.owner)
      expect([refused.status, refused.body.error.code]).toEqual([409, 'channel_archived'])
      expect(refused.body.error.message).toContain('tests is archived')
    }
    expect((await api(name, 'POST', '/tasks', { channel: 'tests', text: 'a task' }, who.owner)).body.error.code).toBe('channel_archived')
    expect((await api(name, 'POST', '/channels', { path: 'tests' }, who.owner)).status).toBe(200)
    expect((await api(name, 'GET', '/messages/' + root, undefined, who.owner)).status).toBe(200)
    expect((await api(name, 'POST', '/messages/' + root + '/delete', {}, who.owner)).status).toBe(200)

    const unarchived = await api(name, 'POST', '/channels/unarchive', { path: 'tests' }, who.owner)
    expect(unarchived.body).toEqual({ unarchived: ['tests'], changed: true })
    expect(await paths(name, who.owner)).toEqual(['general', 'tests'])
    await post(name, who.owner, { channel: 'tests', text: 'back again' })

    const types = (await api(name, 'GET', '/events?after=0&all=true', undefined, who.owner)).body.events.map((event: { type: string }) => event.type)
    expect(types.filter((type: string) => type.startsWith('channel.'))).toEqual(['channel.archived', 'channel.unarchived'])
  })

  it('a subtree takes its channels, its own root, and ones made later; unarchiving inside it leaves it archived', async () => {
    const name = freshBoard('arch-tree')
    const who = await callers(name)
    for (const channel of ['checks', 'checks/a', 'checks/b/c', 'checksum', 'general']) await post(name, who.owner, { channel, text: 'in ' + channel })
    expect((await api(name, 'POST', '/channels/archive', { path: 'checks/a' }, who.owner)).status).toBe(200)
    const tree = await api(name, 'POST', '/channels/archive', { path: 'checks/' }, who.owner)
    expect(tree.body).toMatchObject({ archived: { pattern: 'checks/' }, channels: 3 })
    expect(await paths(name, who.owner)).toEqual(['checksum', 'general'])
    expect((await api(name, 'POST', '/messages', { channel: 'checks/new', text: 'x' }, who.owner)).body.error.message).toContain('(with checks/)')

    const inside = await api(name, 'POST', '/channels/unarchive', { path: 'checks/b/c' }, who.owner)
    expect(inside.body).toMatchObject({ unarchived: [], changed: false, still: { pattern: 'checks/' } })
    const whole = await api(name, 'POST', '/channels/unarchive', { path: 'checks/' }, who.owner)
    expect(whole.body).toEqual({ unarchived: ['checks/', 'checks/a'], changed: true })
    expect(await paths(name, who.owner)).toEqual(['checks', 'checks/a', 'checks/b/c', 'checksum', 'general'])
  })

  it('takes manage everywhere it reaches, and a path that is a channel or a subtree', async () => {
    const name = freshBoard('arch-manage')
    const who = await callers(name)
    await post(name, who.owner, { channel: 'checks/a', text: 'a' })
    await post(name, who.owner, { channel: 'checks/b', text: 'b' })
    // manage in checks itself and checks/a, not checks/b: the subtree reaches checks/b, so it's refused.
    const narrowed = { ...who.member, 'x-board-can': 'checks=all;checks/a=all;checks/b=read,post' }
    expect((await api(name, 'POST', '/channels/archive', { path: 'checks/a' }, narrowed)).status).toBe(200)
    const refused = await api(name, 'POST', '/channels/archive', { path: 'checks/' }, narrowed)
    expect([refused.status, refused.body.error.code]).toEqual([403, 'forbidden'])
    expect((await api(name, 'POST', '/channels/unarchive', { path: 'checks/a' }, { ...who.member, 'x-board-can': 'checks/a=read,post' })).status).toBe(403)
    expect((await api(name, 'POST', '/channels/archive', { path: 'Checks/*' }, who.owner)).status).toBe(400)
  })

  it('counts live posts beside every post ever written, so an emptied channel reads as empty', async () => {
    const name = freshBoard('arch-live')
    const who = await callers(name)
    const ids: string[] = []
    for (const text of ['one', 'two']) {
      const root = await post(name, who.owner, { channel: 'tests', text })
      ids.push(root, await post(name, who.owner, { re: root, text: text + ' reply' }))
    }
    const counts = async () => (await api(name, 'GET', '/channels?archived=true', undefined, who.owner)).body.channels.find((channel: { path: string }) => channel.path === 'tests')
    expect(await counts()).toMatchObject({ messages: 4, threads: 2, live: { messages: 4, threads: 2 } })
    await api(name, 'POST', '/messages/' + ids[1] + '/delete', {}, who.owner)
    expect((await counts()).live).toEqual({ messages: 3, threads: 2 })
    for (const id of ids) await api(name, 'POST', '/messages/' + id + '/delete', {}, who.owner)
    expect(await counts()).toMatchObject({ messages: 4, threads: 2, live: { messages: 0, threads: 0 } })

    // A board from before the live counts: its hot deletes are counted once, when the Ledger starts.
    await runInDurableObject(ledgerOf(name) as unknown as DurableObjectStub, (_instance, state) => {
      state.storage.sql.exec('delete from channel_gone')
      state.storage.sql.exec("delete from meta where key = 'channel_gone'")
    })
    expect((await counts()).live).toEqual({ messages: 4, threads: 2 })
    await evictDurableObject(ledgerOf(name) as unknown as DurableObjectStub)
    expect((await counts()).live).toEqual({ messages: 0, threads: 0 })
    await evictDurableObject(ledgerOf(name) as unknown as DurableObjectStub)
    expect((await counts()).live).toEqual({ messages: 0, threads: 0 })
  })

  it('keeps a private channel private, archived or not', async () => {
    const name = freshBoard('arch-private')
    const who = await callers(name)
    await post(name, who.owner, { channel: 'dm/ada', text: 'a private word' })
    await post(name, who.owner, { channel: 'general', text: 'hello' })
    expect((await api(name, 'POST', '/channels/archive', { path: 'dm/ada' }, who.member)).status).toBe(403)
    // dm/ reaches no one's DM: the member may archive it (nothing of dm/ada tells them it's there), and dm/ada stays live.
    expect((await api(name, 'POST', '/channels/archive', { path: 'dm/' }, who.member)).body).toMatchObject({ channels: 0, changed: true })
    expect(await paths(name, who.ada)).toContain('dm/ada')
    expect((await api(name, 'POST', '/messages', { channel: 'dm/ada', text: 'still open' }, who.owner)).status).toBe(201)
    expect((await api(name, 'POST', '/channels/unarchive', { path: 'dm/' }, who.owner)).status).toBe(200)
    expect((await api(name, 'POST', '/channels/archive', { path: 'dm/ada' }, who.owner)).status).toBe(200)
    expect(await paths(name, who.member, '?archived=true')).toEqual(['general'])
    const seen = (await api(name, 'GET', '/channels?archived=true', undefined, who.ada)).body.channels.find((channel: { path: string }) => channel.path === 'dm/ada')
    expect(seen).toMatchObject({ private: true, archived: { pattern: 'dm/ada' } })
    const events = async (headers: Headers) => (await api(name, 'GET', '/events?after=0&all=true', undefined, headers)).body.events.filter((event: { type: string; payload: { channel: string } }) => event.type === 'channel.archived' && event.payload.channel === 'dm/ada')
    expect(await events(who.member)).toEqual([])
    expect(await events(who.ada)).toHaveLength(1)
  })

  it('wakes no one, hands out no task, and counts nothing unread', async () => {
    const name = freshBoard('arch-quiet')
    const who = await callers(name)
    expect((await api(name, 'POST', '/wakes', { key: 'ada', sink: 'wake', rules: { queue: { ready: 'eng/queue' }, follow: 'follow' } }, who.ada)).status).toBe(201)
    const task = (await api(name, 'POST', '/tasks', { channel: 'eng/queue', text: 'before the archive' }, who.owner)).body.task.id as string
    await until(() => wokenFor(name, 'ada').some((entry) => entry.event.message?.text === 'before the archive'), 'the ready task')
    const thread = await post(name, who.ada, { channel: 'eng/queue', text: 'ada asks' })
    const reply = await post(name, who.owner, { re: thread, text: 'the owner answers' })
    await until(() => wokenFor(name, 'ada').some((entry) => entry.event.message?.text === 'the owner answers'), 'the follow')
    await post(name, who.owner, { channel: 'eng/queue', text: 'something unread for the member' })
    expect((await api(name, 'GET', '/unread', undefined, who.member)).body.channels.map((entry: { channel: string }) => entry.channel)).toEqual(['eng/queue'])

    expect((await api(name, 'POST', '/channels/archive', { path: 'eng/' }, who.owner)).status).toBe(200)
    const before = wokenFor(name, 'ada').length
    // The clean-up: a reply deleted in a thread ada follows, the task reopened as ready by another claim's release.
    await api(name, 'POST', '/messages/' + reply + '/delete', {}, who.owner)
    const claim = await api(name, 'POST', '/tasks/' + task + '/claim', {}, who.owner)
    await api(name, 'POST', '/tasks/' + task + '/release', { epoch: claim.body.claim.epoch, token: claim.body.claim.token }, who.owner)
    expect((await api(name, 'GET', '/messages/' + task, undefined, who.owner)).body.message.task.state).toBe('ready')
    expect((await api(name, 'POST', '/tasks/claim', { channel: 'eng/queue', from: ['workbus:user:jared'] }, who.ada)).body.task).toBeNull()
    expect((await api(name, 'GET', '/unread', undefined, who.member)).body.channels).toEqual([])
    await settle()
    expect(wokenFor(name, 'ada').slice(before)).toEqual([])
  })

  it('skips a schedule\'s firings there while archived, and unarchiving resumes it as it was', async () => {
    const time = clock()
    try {
      const name = freshBoard('arch-schedule')
      const runAlarm = () => runDurableObjectAlarm(ledgerOf(name) as unknown as DurableObjectStub)
      const MINUTE = 60_000
      await post(name, {}, { channel: 'standup', text: 'the channel' })
      const repeating = (await api(name, 'POST', '/schedules', { channel: 'standup', text: 'every minute', every: '1m', times: 3 })).body.schedule
      const once = (await api(name, 'POST', '/schedules', { channel: 'standup', text: 'just once', in: '30s' })).body.schedule
      expect((await api(name, 'POST', '/channels/archive', { path: 'standup' })).status).toBe(200)
      const schedule = async (id: string) => (await api(name, 'GET', '/schedules?all=true')).body.schedules.find((one: { id: string }) => one.id === id)
      const posted = async () => (await api(name, 'GET', '/messages?channel=standup')).body.messages.map((message: { text: string }) => message.text)

      // Past both first times: nothing posted, both still pending, neither firing counted; the repeating one moved on.
      time.advance(MINUTE + 1000)
      await runAlarm()
      expect(await posted()).toEqual(['the channel'])
      expect(await schedule(repeating.id)).toMatchObject({ state: 'pending', sent: 0, canceled: null, next: new Date(Date.parse(repeating.first) + MINUTE).toISOString() })
      expect(await schedule(once.id)).toMatchObject({ state: 'pending', sent: 0, canceled: null })

      // Unarchived: the one-time one posts at once, and the repeating one at its next time.
      expect((await api(name, 'POST', '/channels/unarchive', { path: 'standup' })).status).toBe(200)
      await runAlarm()
      expect(await posted()).toEqual(['the channel', 'just once'])
      expect(await schedule(once.id)).toMatchObject({ state: 'done', sent: 1 })
      time.advance(MINUTE)
      await runAlarm()
      expect(await posted()).toEqual(['the channel', 'just once', 'every minute'])
      expect(await schedule(repeating.id)).toMatchObject({ state: 'pending', sent: 1 })
    } finally {
      time.restore()
    }
  })
})

// Wakes (design/registered-watchers.md): registered watchers the board delivers to a service
// sink its deployment declares (test/worker.ts: wake, to test/wake.ts). Each matches as the caller
// that set it, profile and narrowing too, and is delivered by a Mailbox in order per thread,
// with retries. Everything runs on the wall clock: the Mailbox's real alarms.
import { describe, expect, it } from 'vitest'
import { api, freshBoard, ledgerOf, tokenFor, until } from './helpers.ts'
import { wakePrincipals, wokenFor, type Woken } from './wake.ts'

type Headers = Record<string, string>
const ADA = 'worker:workbus-app+ada'
const bearer = async (name: string, sub: string, claims: Record<string, unknown>, more: Headers = {}): Promise<Headers> => ({ authorization: 'Bearer ' + (await tokenFor(name, sub, { claims })), ...more })
async function callers(name: string) {
  return {
    owner: await bearer(name, 'jared', { role: 'owner' }),
    member: await bearer(name, 'mallory', { role: 'member' }),
    app: await bearer(name, 'workbus-app', { kind: 'workload' }),
    ada: await bearer(name, 'workbus-app', { kind: 'workload' }, { 'x-board-profile': 'ada' }),
    bob: await bearer(name, 'workbus-app', { kind: 'workload' }, { 'x-board-profile': 'bob' }),
  }
}
const post = async (name: string, headers: Headers, body: Record<string, unknown>) => {
  const posted = await api(name, 'POST', '/messages', body, headers)
  expect(posted.status).toBe(201)
  return posted.body.message.id as string
}
const ok = (entries: Woken[]) => entries.filter((entry) => entry.ok)
const texts = (entries: Woken[]) => entries.map((entry) => entry.event.message?.text)
/** Lets a write that should wake nothing be handed on and delivered if it were going to be. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 600))

describe('wakes', () => {
  it('names only a sink the deployment declares, and only one that lets its principal target it', async () => {
    const name = freshBoard('sub-sinks')
    const who = await callers(name)
    const nowhere = await api(name, 'POST', '/wakes', { key: 'ada', sink: 'nowhere', rules: { mention: 'mention' } }, who.ada)
    expect([nowhere.status, nowhere.body.error.code]).toEqual([404, 'sink_not_found'])
    const elsewhere = await api(name, 'POST', '/wakes', { key: 'ada', sink: 'elsewhere', rules: { mention: 'mention' } }, who.ada)
    expect([elsewhere.status, elsewhere.body.error.code]).toEqual([403, 'sink_forbidden'])
    // A person, even the owner, isn't the app.
    const person = await api(name, 'POST', '/wakes', { key: 'mine', sink: 'wake', rules: { mention: 'mention' } }, who.owner)
    expect([person.status, person.body.error.code]).toEqual([403, 'sink_forbidden'])
    // A sink is a name, never a binding a registrant gives.
    const given = await api(name, 'POST', '/wakes', { key: 'ada', sink: { binding: 'WAKE' }, rules: { mention: 'mention' } }, who.ada)
    expect(given.status).toBe(400)
    const made = await api(name, 'POST', '/wakes', { key: 'ada', sink: 'wake', rules: { mention: 'mention' } }, who.ada)
    expect([made.status, made.body.wake.actor, made.body.changed]).toEqual([201, ADA, true])
    // Listing is by principal: the app sees its seat's, a person who can't manage everything sees none.
    expect((await api(name, 'GET', '/wakes', undefined, who.app)).body.wakes.map((wake: { key: string }) => wake.key)).toEqual(['ada'])
    expect((await api(name, 'GET', '/wakes', undefined, { ...who.member, 'x-board-can': 'general=read' })).body.wakes).toEqual([])
  })

  it('an upsert by key is idempotent, and a revision orders applies', async () => {
    const name = freshBoard('sub-upsert')
    const who = await callers(name)
    const body = { key: 'ada', sink: 'wake', rules: { mention: 'mention', follow: 'follow' }, revision: 3 }
    expect((await api(name, 'POST', '/wakes', body, who.ada)).status).toBe(201)
    const again = await api(name, 'POST', '/wakes', { ...body, rules: { follow: 'follow', mention: 'mention' } }, who.ada)
    expect([again.status, again.body.changed]).toEqual([200, false])
    const listed = (await api(name, 'GET', '/wakes', undefined, who.app)).body.wakes
    expect(listed).toHaveLength(1)
    expect(listed[0]).toMatchObject({ key: 'ada', sink: 'wake', revision: 3, actor: ADA, principal: 'worker:workbus-app' })

    const older = await api(name, 'POST', '/wakes', { ...body, rules: { dm: 'dm' }, revision: 2 }, who.ada)
    expect([older.status, older.body.changed, older.body.stale, older.body.wake.rules]).toEqual([200, false, true, body.rules])
    const conflict = await api(name, 'POST', '/wakes', { ...body, rules: { dm: 'dm' } }, who.ada)
    expect([conflict.status, conflict.body.error.code]).toEqual([409, 'revision_conflict'])
    const newer = await api(name, 'POST', '/wakes', { ...body, rules: { dm: 'dm' }, revision: 4 }, who.ada)
    expect([newer.status, newer.body.changed, newer.body.wake.rules]).toEqual([200, true, { dm: 'dm' }])
    expect((await api(name, 'GET', '/wakes', undefined, who.app)).body.wakes).toHaveLength(1)

    const stale = await api(name, 'POST', '/wakes/ada/delete', { revision: 3 }, who.app)
    expect(stale.body).toEqual({ removed: false, stale: true })
    expect((await api(name, 'POST', '/wakes/ada/delete', { revision: 4 }, who.app)).body).toEqual({ removed: true })
    expect((await api(name, 'POST', '/wakes/ada/delete', undefined, who.app)).body).toEqual({ removed: false })
    expect((await api(name, 'GET', '/wakes', undefined, who.app)).body.wakes).toEqual([])
  })

  it("wakes a seat by each rule its seat doc holds, and never for its own writes", async () => {
    const name = freshBoard('sub-rules')
    const who = await callers(name)
    const rules = { mention: 'mention', follow: 'follow', assigned: 'assigned', queue: { ready: 'work/' }, dm: 'dm', specs: { docs: 'specs/' }, schedules: 'schedules', urgent: { tail: 'general --label urgent' } }
    expect((await api(name, 'POST', '/wakes', { key: 'ada', sink: 'wake', rules }, who.ada)).status).toBe(201)
    const woke = (rule: string) => ok(wokenFor(name, 'ada')).filter((entry) => entry.rules.includes(rule))

    await post(name, who.owner, { channel: 'general', text: 'over to @[' + ADA + '] for this' })
    await until(() => woke('mention').length === 1, 'the mention')
    expect(woke('mention')[0]!.event).toMatchObject({ type: 'message.posted', message: { text: 'over to @[' + ADA + '] for this' } })

    const own = await post(name, who.ada, { channel: 'general', text: 'ada starts a thread' })
    await post(name, who.owner, { re: own, text: 'the owner answers it' })
    await until(() => woke('follow').some((entry) => entry.event.message?.text === 'the owner answers it'), 'the follow')

    const assigned = await api(name, 'POST', '/tasks', { channel: 'eng', text: 'a task for ada', for: ADA }, who.app)
    expect(assigned.status).toBe(201)
    await until(() => woke('assigned').some((entry) => entry.event.type === 'task.created'), 'the assignment')

    expect((await api(name, 'POST', '/tasks', { channel: 'work/queue', text: 'anyone may take this' }, who.owner)).status).toBe(201)
    // Ready at once: its task.created is when it became ready.
    await until(() => woke('queue').some((entry) => entry.event.type === 'task.created' && entry.event.message?.text === 'anyone may take this'), 'the ready task')

    await post(name, who.owner, { channel: 'dm/ada', text: 'a word in private' })
    await until(() => woke('dm').length === 1, 'the dm')

    expect((await api(name, 'POST', '/docs', { channel: 'specs', slug: 'api', body: '# API\n\nThe spec.\n' }, who.owner)).status).toBe(201)
    await until(() => woke('specs').some((entry) => entry.event.type === 'doc.created'), 'the doc')

    await post(name, who.owner, { channel: 'general', text: 'on fire', labels: { urgent: 'yes' } })
    await until(() => woke('urgent').length === 1, 'the tail')

    expect((await api(name, 'POST', '/schedules', { channel: 'standup', text: 'ada checks in', in: '1s' }, who.ada)).status).toBe(201)
    await until(() => woke('schedules').length === 1, 'its own schedule', 10_000)
    expect(woke('schedules')[0]!.event.message?.text).toBe('ada checks in')

    // Nothing ada wrote woke it but its schedule, and nothing woke it twice.
    await settle()
    const all = ok(wokenFor(name, 'ada'))
    expect(all.filter((entry) => entry.event.message?.text === 'ada starts a thread')).toEqual([])
    expect(new Set(all.map((entry) => entry.event.cursor)).size).toBe(all.length)
    expect(all.every((entry) => entry.actor === ADA)).toBe(true)
    // One event, one delivery, every rule it met: the mention is also in a thread ada now follows.
    expect(woke('mention')[0]!.rules).toEqual(['mention', 'follow'])
  })

  it("sees what its profile sees: its own DM and nothing private beyond its parties, nothing its narrowing hides", async () => {
    const name = freshBoard('sub-private')
    const who = await callers(name)
    const everything = { all: { tail: '' } }
    const narrowed = { ...who.ada, 'x-board-can': 'work/=read,post;dm/ada=all' }
    expect((await api(name, 'POST', '/wakes', { key: 'ada', sink: 'wake', rules: everything }, who.ada)).status).toBe(201)
    expect((await api(name, 'POST', '/wakes', { key: 'ada-narrow', sink: 'wake', rules: everything }, narrowed)).status).toBe(201)
    expect((await api(name, 'POST', '/wakes', { key: 'app', sink: 'wake', rules: everything }, who.app)).status).toBe(201)
    // A rule for a dm needs a profile.
    expect((await api(name, 'POST', '/wakes', { key: 'app-dm', sink: 'wake', rules: { dm: 'dm' } }, who.app)).status).toBe(400)

    await post(name, who.owner, { channel: 'dm/ada', text: 'for ada alone' })
    await post(name, who.owner, { channel: 'dm/bob', text: 'for bob alone' })
    await post(name, who.owner, { channel: 'general', text: 'for everyone' })
    await post(name, who.owner, { channel: 'work/queue', text: 'for the queue' })
    await until(() => ok(wokenFor(name, 'ada')).length >= 3 && ok(wokenFor(name, 'ada-narrow')).length >= 2 && ok(wokenFor(name, 'app')).length >= 2, 'the deliveries')
    await settle()
    expect(texts(ok(wokenFor(name, 'ada'))).sort()).toEqual(['for ada alone', 'for everyone', 'for the queue'])
    expect(texts(ok(wokenFor(name, 'ada-narrow'))).sort()).toEqual(['for ada alone', 'for the queue'])
    // The app with no profile is no party to any seat's DM.
    expect(texts(ok(wokenFor(name, 'app'))).sort()).toEqual(['for everyone', 'for the queue'])
    const listed = (await api(name, 'GET', '/wakes', undefined, who.app)).body.wakes
    expect(listed.find((wake: { key: string }) => wake.key === 'ada-narrow').can).toBe('work/=read,post;dm/ada=all')
  })

  it('delivers in order per thread, retries a sink that fails, and other threads go on', async () => {
    const name = freshBoard('sub-order')
    const who = await callers(name)
    expect((await api(name, 'POST', '/wakes', { key: 'ada', sink: 'wake', rules: { all: { tail: '' } } }, who.ada)).status).toBe(201)
    const root = await post(name, who.owner, { channel: 'general', text: 'wake-fail-twice: the root' })
    await post(name, who.owner, { re: root, text: 'first reply' })
    await post(name, who.owner, { re: root, text: 'second reply' })
    await post(name, who.owner, { channel: 'general', text: 'another thread' })

    await until(() => ok(wokenFor(name, 'ada')).length >= 4, 'four deliveries', 20_000)
    const tries = wokenFor(name, 'ada')
    const rootTries = tries.filter((entry) => entry.event.message?.id === root)
    expect(rootTries.map((entry) => [entry.attempt, entry.ok])).toEqual([[1, false], [2, false], [3, true]])
    expect(rootTries[1]!.at - rootTries[0]!.at).toBeGreaterThanOrEqual(950)
    const delivered = ok(tries)
    const at = (text: string) => delivered.find((entry) => entry.event.message?.text === text)!.at
    expect(at('first reply')).toBeGreaterThanOrEqual(rootTries[2]!.at)
    expect(at('second reply')).toBeGreaterThanOrEqual(at('first reply'))
    expect(at('another thread')).toBeLessThan(rootTries[2]!.at)
    // Each match is its wake's and its event's: what a receiver dedupes on.
    expect(delivered.map((entry) => entry.match)).toEqual(delivered.map((entry) => 'wake:worker:workbus-app/ada:' + entry.event.cursor))
  })

  it('stops when removed, and when the sink no longer lets its principal target it', async () => {
    const name = freshBoard('sub-stop')
    const who = await callers(name)
    expect((await api(name, 'POST', '/wakes', { key: 'ada', sink: 'wake', rules: { all: { tail: '' } } }, who.ada)).status).toBe(201)
    await post(name, who.owner, { channel: 'general', text: 'one' })
    await until(() => ok(wokenFor(name, 'ada')).length === 1, 'the first')

    wakePrincipals.length = 0
    try {
      await post(name, who.owner, { channel: 'general', text: 'two, while the sink is closed' })
      await settle()
    } finally {
      wakePrincipals.push('worker:workbus-app')
    }
    await post(name, who.owner, { channel: 'general', text: 'three' })
    await until(() => ok(wokenFor(name, 'ada')).length === 2, 'the third')
    expect(texts(ok(wokenFor(name, 'ada')))).toEqual(['one', 'three'])

    expect((await api(name, 'POST', '/wakes/ada/delete', undefined, who.app)).body).toEqual({ removed: true })
    await post(name, who.owner, { channel: 'general', text: 'four, after it was removed' })
    await settle()
    expect(texts(ok(wokenFor(name, 'ada')))).toEqual(['one', 'three'])
  })

  it('wakes the seat that parked on a task when the principal answers its hold, with the decision', async () => {
    const name = freshBoard('wake-answer')
    const who = await callers(name)
    // ada serves a queue it isn't assigned in: the task is its only by its claim, then by its hold.
    expect((await api(name, 'POST', '/wakes', { key: 'ada', sink: 'wake', rules: { assigned: 'assigned' } }, who.ada)).status).toBe(201)
    expect((await api(name, 'POST', '/wakes', { key: 'bob', sink: 'wake', rules: { assigned: 'assigned' } }, who.bob)).status).toBe(201)
    const made = await api(name, 'POST', '/tasks', { channel: 'work/queue', text: 'deploy the fix' }, who.owner)
    expect(made.status).toBe(201)
    const id = made.body.task.id as string
    const claimed = await api(name, 'POST', '/tasks/' + id + '/claim', {}, who.ada)
    expect(claimed.status).toBe(200)
    const { epoch, token } = claimed.body.claim
    // The owner says something in the thread while ada holds it: that's ada's too.
    await post(name, who.owner, { re: id, text: 'use the canary first' })
    await until(() => ok(wokenFor(name, 'ada')).some((entry) => entry.event.message?.text === 'use the canary first'), 'the reply on its claimed task')
    // ada parks on it for an approval; the owner approves.
    expect((await api(name, 'POST', '/tasks/' + id + '/block', { reason: 'may I deploy?', kind: 'approval', epoch, token }, who.ada)).status).toBe(200)
    const answered = await api(name, 'POST', '/tasks/' + id + '/unblock', { decision: 'approved', note: 'go ahead' }, who.owner)
    expect(answered.status).toBe(200)
    const answer = await until(() => ok(wokenFor(name, 'ada')).find((entry) => entry.event.type === 'task.unblocked'), 'the answer')
    expect(answer.rules).toEqual(['assigned'])
    expect(answer.event.payload).toMatchObject({ decision: 'approved', note: 'go ahead', holder: ADA })
    // Its own block woke it not at all, and the answer reached no other seat.
    await settle()
    expect(ok(wokenFor(name, 'ada')).filter((entry) => entry.event.type === 'task.blocked')).toEqual([])
    expect(ok(wokenFor(name, 'bob'))).toEqual([])
  })

  it("hands a wake's sink no board: only a config watcher acts as the board's own code", async () => {
    const name = freshBoard('sub-act')
    const id = await post(name, await bearer(name, 'jared', { role: 'owner' }), { channel: 'general', text: 'hello' })
    const refused = await (ledgerOf(name) as unknown as { act(...args: unknown[]): Promise<unknown> }).act('wake:worker:workbus-app/ada', 'wake:worker:workbus-app/ada:1', 'message', [id]).then(() => null, (error: Error) => error.message)
    expect(refused).toContain('no watcher')
  })
})

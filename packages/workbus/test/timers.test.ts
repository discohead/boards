// Timers: every timer a board has (leases, schedules) is a row, and one alarm serves them all. Time
// moves by a clock the test advances (Date.now, which the Ledger shares in this isolate); the alarm is
// run when the test says, so nothing waits on the wall clock.
import { runDurableObjectAlarm, runInDurableObject } from 'cloudflare:test'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { postMessage } from '../src/ledger/messages.ts'
import { op, TIMERS } from '../src/ledger/ops.ts'
import { api, clock, freshBoard, ledgerOf, mountOf, person, rows } from './helpers.ts'

const MINUTE = 60_000
let time: ReturnType<typeof clock>
beforeEach(() => void (time = clock()))
afterEach(() => time.restore())

const alarmOf = (name: string) => runInDurableObject(ledgerOf(name) as unknown as DurableObjectStub, (_instance, state) => state.storage.getAlarm())
const runAlarm = (name: string) => runDurableObjectAlarm(ledgerOf(name) as unknown as DurableObjectStub)
/** Runs the alarm as the runtime would: again whenever it's set for a time that has come. How many runs. */
async function alarmsDue(name: string, most = 5) {
  let ran = 0
  for (; ran < most; ran++) {
    const at = await alarmOf(name)
    if (at === null || at > Date.now()) break
    await runAlarm(name)
  }
  return ran
}
const timers = (name: string) => rows<{ kind: string; ref: string; due: number }>(name, 'select kind, ref, due from timers order by due')
const eventsOf = async (name: string, type: string) => (await api(name, 'GET', '/events?after=0&all=true')).body.events.filter((event: { type: string }) => event.type === type)
const taskOf = async (name: string, id: string) => (await api(name, 'GET', '/messages/' + id)).body.message.task

// A timer kind that fails: it posts, then throws, so the post must not land. After 3 runs it stops
// failing, so a Ledger that retried it at once would show it rather than spin forever.
const runs = { boom: 0, fine: 0 }
TIMERS.testBoom = (ctx) => {
  runs.boom++
  postMessage(ctx, { channel: 'general', text: 'boom ' + runs.boom })
  if (runs.boom <= 3) throw new Error('the timer failed')
}
TIMERS.testFine = () => void runs.fine++
op('testArm', (ctx, input: { kind: string; ref: string; due: number }) => {
  ctx.timer(input.kind, input.ref, input.due)
  return {}
})

describe('timers', () => {
  it('one alarm multiplexes many timers: leases and a schedule, all due, all run by one alarm', async () => {
    const name = freshBoard('multiplex')
    const claimed = []
    // Each timer due sooner than the last: the one alarm moves earlier for each.
    for (const lease of [50, 40, 30]) {
      const made = await api(name, 'POST', '/tasks', { channel: 'work', text: 'task with a ' + lease + 's lease', claim: true, lease })
      expect(made.status).toBe(201)
      claimed.push(made.body.task.id)
    }
    expect((await api(name, 'POST', '/schedules', { channel: 'general', text: 'reminder', in: '45s' })).status).toBe(201)

    const armed = await timers(name)
    expect(armed.map((timer) => timer.kind)).toEqual(['lease', 'lease', 'send', 'lease'])
    expect(await alarmOf(name)).toBe(armed[0]!.due)

    time.advance(MINUTE)
    expect(await runAlarm(name)).toBe(true)

    expect((await eventsOf(name, 'task.expired')).map((event: { message: { id: string } }) => event.message.id)).toEqual([...claimed].reverse())
    for (const id of claimed) expect(await taskOf(name, id)).toMatchObject({ state: 'ready', claim: null })
    const general = await api(name, 'GET', '/messages?channel=general')
    expect(general.body.messages.map((message: { text: string }) => message.text)).toEqual(['reminder'])
    expect(await timers(name)).toEqual([])
    expect(await alarmOf(name)).toBeNull()
  })

  it('a lease timer expires a claim: task.expired lands, the task is ready, and the next claim is a new epoch', async () => {
    const name = freshBoard('lease')
    const made = await api(name, 'POST', '/tasks', { channel: 'work', text: 'fix the build', claim: true, lease: 30 })
    const id = made.body.task.id

    time.advance(29_000)
    await runAlarm(name)
    expect(await taskOf(name, id)).toMatchObject({ state: 'claimed', epoch: 1 })
    expect(await eventsOf(name, 'task.expired')).toEqual([])

    time.advance(2_000)
    await runAlarm(name)
    const expired = await eventsOf(name, 'task.expired')
    expect(expired).toHaveLength(1)
    expect(expired[0]).toMatchObject({ message: { id }, payload: { epoch: 1 } })
    expect(await taskOf(name, id)).toMatchObject({ state: 'ready', claim: null })
    const again = await api(name, 'POST', '/tasks/' + id + '/claim', { lease: 30 })
    expect(again.status).toBe(200)
    expect(again.body.claim.epoch).toBe(2)
  })

  it("a renewed lease isn't expired at its old time", async () => {
    const name = freshBoard('renew')
    const made = await api(name, 'POST', '/tasks', { channel: 'work', text: 'long job', claim: true, lease: 30 })
    const id = made.body.task.id
    time.advance(20_000)
    const renewed = await api(name, 'POST', '/tasks/' + id + '/renew', { epoch: made.body.claim.epoch, token: made.body.claim.token, lease: 60 })
    expect(renewed.status).toBe(200)

    time.advance(20_000)
    await runAlarm(name)
    expect(await eventsOf(name, 'task.expired')).toEqual([])
    expect(await taskOf(name, id)).toMatchObject({ state: 'claimed' })

    time.advance(41_000)
    await runAlarm(name)
    expect(await eventsOf(name, 'task.expired')).toHaveLength(1)
  })

  it('a schedule sends at its time, and repeats', async () => {
    const name = freshBoard('schedule')
    const made = await api(name, 'POST', '/schedules', { channel: 'standup', text: 'standup time', every: '1m', times: 2 })
    expect(made.status).toBe(201)
    const sent = async () => (await api(name, 'GET', '/messages?channel=standup')).body.messages ?? []

    time.advance(30_000)
    await runAlarm(name)
    expect(await sent()).toEqual([])

    time.advance(31_000)
    await runAlarm(name)
    expect((await sent()).map((message: { text: string }) => message.text)).toEqual(['standup time'])
    expect(await alarmOf(name)).toBe(Date.parse(made.body.schedule.first) + MINUTE)

    time.advance(MINUTE)
    await runAlarm(name)
    expect((await sent()).map((message: { text: string }) => message.text)).toEqual(['standup time', 'standup time'])
    const posted = await eventsOf(name, 'message.posted')
    expect(posted.map((event: { payload: { schedule: { id: string; n: number } } }) => event.payload.schedule)).toEqual([{ id: 's1', n: 0 }, { id: 's1', n: 1 }])
    const listed = await api(name, 'GET', '/schedules?all=true')
    expect(listed.body.schedules[0]).toMatchObject({ state: 'done', sent: 2, next: null })

    time.advance(MINUTE)
    await runAlarm(name)
    expect(await sent()).toHaveLength(2)
    expect(await timers(name)).toEqual([])
  })

  it("a timer that throws writes nothing, is retried a minute on, and doesn't spin: the alarm moves on", async () => {
    const name = freshBoard('boom')
    expect((await api(name, 'GET', '/me')).status).toBe(200)
    runs.boom = 0
    runs.fine = 0
    const due = Date.now() + 10 * MINUTE
    for (const kind of ['testBoom', 'testFine']) expect((await ledgerOf(name).call(person(), 'testArm', { kind, ref: name, due }, mountOf(name))).ok).toBe(true)

    time.advance(10 * MINUTE)
    const ranAt = Date.now()
    const woke = await alarmsDue(name)

    expect(woke).toBe(1)
    expect(runs).toEqual({ boom: 1, fine: 1 })
    expect(await rows(name, "select text from messages where text like 'boom%'")).toEqual([])
    const [retry] = await timers(name)
    expect(retry).toMatchObject({ kind: 'testBoom', ref: name })
    expect(retry!.due).toBeGreaterThanOrEqual(ranAt + MINUTE)
    expect(retry!.due).toBeLessThan(ranAt + MINUTE + 5_000)
    expect(await alarmOf(name)).toBe(retry!.due)

    time.advance(MINUTE + 1_000)
    expect(await alarmsDue(name)).toBeGreaterThan(0)
    expect(runs).toEqual({ boom: 2, fine: 1 })
  })
})

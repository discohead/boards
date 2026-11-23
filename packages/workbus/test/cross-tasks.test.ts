// Tasks across people and seats (design/cross-principal-tasks.md, #10): a person assigns work to a
// seat, a seat holds it for the person, the person answers or finishes it. What lets each one is a
// grant (manage in the channel) or being the task's owner, never who works with whom.
import { describe, expect, it } from 'vitest'
import { api, freshBoard, tokenFor } from './helpers.ts'

type Headers = Record<string, string>
const bearer = async (name: string, sub: string, claims: Record<string, unknown>, more: Headers = {}): Promise<Headers> => ({ authorization: 'Bearer ' + (await tokenFor(name, sub, { claims })), ...more })
const ENG = 'worker:workbus-app+eng'
const OP = 'worker:workbus-app+op'

async function callers(name: string) {
  const app = await bearer(name, 'workbus-app', { kind: 'workload' })
  const who = {
    // The board's owner: people have manage everywhere by the starting grants.
    jared: await bearer(name, 'jared', { role: 'owner', name: 'Jared' }),
    // A person without manage in eng: its owner only for what it made.
    mia: await bearer(name, 'mia', { role: 'member' }, { 'x-board-can': 'eng=read,post,react,label' }),
    lee: await bearer(name, 'lee', { role: 'member' }, { 'x-board-can': 'eng=read,post,react,label' }),
    app,
    op: { ...app, 'x-board-profile': 'op;name="Operator";handle="op"' },
    eng: { ...app, 'x-board-profile': 'eng;name="Engineer";handle="eng"' },
    bob: { ...app, 'x-board-profile': 'bob;name="Bob";handle="bob"' },
  }
  // The app has written (as the operator), so its seats are profiles of a principal the board knows.
  expect((await api(name, 'POST', '/messages', { channel: 'eng', text: 'the operator is here' }, who.op)).status).toBe(201)
  return who
}

const make = async (name: string, who: Headers, body: Record<string, unknown>) => {
  const made = await api(name, 'POST', '/tasks', { channel: 'eng', ...body }, who)
  expect(made.status, JSON.stringify(made.body)).toBe(201)
  return made.body.task.id as string
}
const claim = async (name: string, id: string, who: Headers) => {
  const claimed = await api(name, 'POST', '/tasks/' + id + '/claim', { lease: 60 }, who)
  expect(claimed.status, JSON.stringify(claimed.body)).toBe(200)
  return claimed.body.claim as { epoch: number; token: string }
}
const stateOf = async (name: string, id: string) => (await api(name, 'GET', '/messages/' + id)).body.message.task

describe('tasks across people and seats', () => {
  it('a person assigns a task to a seat, which claims it; no one else can, and for names someone on the board', async () => {
    const name = freshBoard('cross-assign')
    const who = await callers(name)
    // Made for a seat that hasn't written yet: a profile of a principal the board knows.
    const id = await make(name, who.jared, { text: 'for the engineer', for: ENG })
    expect((await stateOf(name, id)).for).toBe(ENG)
    expect((await api(name, 'POST', '/tasks/' + id + '/claim', {}, who.bob)).body.error.code).toBe('task_assigned')
    expect((await api(name, 'POST', '/tasks/' + id + '/claim', {}, who.jared)).body.error.code).toBe('task_assigned')
    // The seat takes it from the queue: tasks for it come first, whoever owns them.
    const next = await api(name, 'POST', '/tasks/claim', { channel: 'eng' }, who.eng)
    expect(next.body.task.id).toBe(id)
    expect(next.body.task.task.claim.actor).toBe(ENG)

    // The operator assigns its own task to another seat, and a person reassigns it to themselves.
    const ops = await make(name, who.op, { text: 'the operator routes this' })
    expect((await api(name, 'POST', '/tasks/' + ops + '/assign', { for: ENG }, who.op)).body.task.task.for).toBe(ENG)
    expect((await api(name, 'POST', '/tasks/' + ops + '/assign', { for: 'workbus:user:jared' }, who.jared)).body.task.task.for).toBe('workbus:user:jared')
    expect((await api(name, 'POST', '/tasks/' + ops + '/claim', { lease: 60 }, who.jared)).status).toBe(200)
    // A seat can't reassign a task it didn't make, and no one names an actor the board doesn't know.
    expect((await api(name, 'POST', '/tasks/' + ops + '/assign', { for: ENG }, who.bob)).body.error.code).toBe('task_not_owned')
    for (const nobody of ['workbus:user:nobody', 'worker:nobody+eng', 'eng'])
      expect((await api(name, 'POST', '/tasks', { channel: 'eng', text: 'for nobody', for: nobody }, who.jared)).status, nobody).toBe(400)
  })

  it('a seat holds its task for a person, and only manage, or the owner as themselves, answers it', async () => {
    const name = freshBoard('cross-answer')
    const who = await callers(name)
    // Made by the operator for the engineer, held by the engineer's claim for an approval.
    const id = await make(name, who.op, { text: 'deploy it', for: ENG })
    const held = await claim(name, id, who.eng)
    const block = await api(name, 'POST', '/tasks/' + id + '/block', { reason: 'may I deploy?', kind: 'approval', ...held }, who.eng)
    expect(block.body.task.task).toMatchObject({ state: 'blocked', blocked: { kind: 'approval', reason: 'may I deploy?' }, answer: null })
    // Not the operator that made it, not the app as itself, not the seat that holds it.
    for (const [whose, headers] of [['the operator', who.op], ['the app', who.app], ['the seat', who.eng], ['a person without manage', who.mia]] as const) {
      const refused = await api(name, 'POST', '/tasks/' + id + '/unblock', { decision: 'approved' }, headers)
      expect(refused.status, whose).toBe(403)
      expect(refused.body.error.code, whose).toBe('task_not_owned')
    }
    // The principal approves from the inbox: the task is ready again, with the answer on it.
    const approved = await api(name, 'POST', '/tasks/' + id + '/unblock', { decision: 'approved', note: 'go ahead' }, who.jared)
    expect(approved.body.task.task).toMatchObject({ state: 'ready', blocked: null, answer: { decision: 'approved', note: 'go ahead', by: 'workbus:user:jared' } })
    const events = (await api(name, 'GET', '/events?last=5')).body.events as { type: string; payload: Record<string, unknown> }[]
    expect(events.find((event) => event.type === 'task.unblocked')?.payload).toMatchObject({ decision: 'approved', note: 'go ahead' })

    // Held again, the answer is cleared; declined, it's given back all the same, with the decline on it.
    const again = await claim(name, id, who.eng)
    expect((await api(name, 'POST', '/tasks/' + id + '/block', { reason: 'and prod?', kind: 'approval', ...again }, who.eng)).body.task.task.answer).toBeNull()
    const declined = await api(name, 'POST', '/tasks/' + id + '/unblock', { decision: 'declined', note: 'not prod' }, who.jared)
    expect(declined.body.task.task).toMatchObject({ state: 'ready', answer: { decision: 'declined', note: 'not prod' } })
    expect((await api(name, 'POST', '/tasks/' + id + '/unblock', { note: 'no decision' }, who.jared)).status).toBe(400)

    // A person without manage answers a hold on a task they made, as themselves: not another
    // person, and not their own profile.
    const mine = await make(name, who.mia, { text: 'mia asks the engineer', for: ENG })
    const hers = await claim(name, mine, who.eng)
    await api(name, 'POST', '/tasks/' + mine + '/block', { reason: 'which one?', kind: 'decision', ...hers }, who.eng)
    expect((await api(name, 'POST', '/tasks/' + mine + '/unblock', { decision: 'approved' }, who.lee)).status).toBe(403)
    expect((await api(name, 'POST', '/tasks/' + mine + '/unblock', { decision: 'approved' }, { ...who.mia, 'x-board-profile': 'helper' })).status).toBe(403)
    expect((await api(name, 'POST', '/tasks/' + mine + '/unblock', { decision: 'approved', note: 'the first' }, who.mia)).body.task.task.answer).toMatchObject({ decision: 'approved', by: 'workbus:user:mia' })

    // A hold its owner placed without a claim is the owner's to lift, as before.
    const own = await make(name, who.op, { text: 'the operator waits' })
    expect((await api(name, 'POST', '/tasks/' + own + '/block', { reason: 'later' }, who.op)).body.task.task.state).toBe('blocked')
    expect((await api(name, 'POST', '/tasks/' + own + '/unblock', {}, who.op)).body.task.task).toMatchObject({ state: 'ready', answer: null })
  })

  it("the owner finishes, fails, or takes back a task a seat holds, without the claim; the seat's claim is over", async () => {
    const name = freshBoard('cross-finish')
    const who = await callers(name)
    const first = await make(name, who.jared, { text: 'first', for: ENG })
    const second = await make(name, who.jared, { text: 'second, after the first', for: ENG, needs: [first] })
    const held = await claim(name, first, who.eng)
    // Not a seat that doesn't own it, and not half a proof.
    expect((await api(name, 'POST', '/tasks/' + first + '/complete', {}, who.bob)).body.error.code).toBe('task_not_owned')
    expect((await api(name, 'POST', '/tasks/' + first + '/complete', { epoch: held.epoch }, who.jared)).status).toBe(400)
    // Waiting isn't ready to finish.
    expect((await api(name, 'POST', '/tasks/' + second + '/complete', {}, who.jared)).body.error.code).toBe('task_waiting')
    // The principal completes it: the next is ready, and the seat's claim is lost.
    const done = await api(name, 'POST', '/tasks/' + first + '/complete', { result: 'done by hand' }, who.jared)
    expect(done.body.task.task).toMatchObject({ state: 'completed', claim: null, result: 'done by hand' })
    expect((await stateOf(name, second)).state).toBe('ready')
    expect((await api(name, 'POST', '/tasks/' + first + '/complete', held, who.eng)).body.error.code).toBe('claim_lost')

    // Taken back: ready again, and the old claim can't write.
    const taken = await claim(name, second, who.eng)
    expect((await api(name, 'POST', '/tasks/' + second + '/release', {}, who.jared)).body.task.task).toMatchObject({ state: 'ready', claim: null })
    expect((await api(name, 'POST', '/tasks/' + second + '/renew', taken, who.eng)).body.error.code).toBe('claim_lost')
    // Failed by the operator that made it, while a seat holds it.
    const routed = await make(name, who.op, { text: 'routed', for: ENG })
    await claim(name, routed, who.eng)
    expect((await api(name, 'POST', '/tasks/' + routed + '/fail', { reason: 'stalled' }, who.op)).body.task.task).toMatchObject({ state: 'failed', reason: 'stalled', claim: null })
    // A held task is answered or canceled, not finished.
    const blocked = await make(name, who.jared, { text: 'held' })
    await api(name, 'POST', '/tasks/' + blocked + '/block', { reason: 'wait' }, who.jared)
    expect((await api(name, 'POST', '/tasks/' + blocked + '/complete', {}, who.jared)).body.error.code).toBe('task_blocked')
  })
})

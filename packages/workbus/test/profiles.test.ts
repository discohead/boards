// Profiles with a key, a handle, and a name (design/workbus.md §5.1, §11): the actor is
// <principal>+<key> whatever it's called; a claimed handle (@op) is what mentions settle to, one
// actor's on the board; and a rename or a new handle keeps its history, follows, tasks, and DM.
import { env, runDurableObjectAlarm } from 'cloudflare:test'
import { describe, expect, it } from 'vitest'
import { Board } from '../src/binding.ts'
import type { Caller } from '../src/ledger/core.ts'
import { api, clock, freshBoard, ledgerOf, mountOf, tokenFor } from './helpers.ts'

type Headers = Record<string, string>
const bearer = async (name: string, sub: string, claims: Record<string, unknown>, more: Headers = {}): Promise<Headers> => ({ authorization: 'Bearer ' + (await tokenFor(name, sub, { claims })), ...more })
const OP = 'worker:workbus-app+op'

describe('profiles: a key, a handle, a name', () => {
  it('a seat claims @op: mentions settle to it, and a rename or a new handle keeps the same actor and all it had', async () => {
    const name = freshBoard('profile-handle')
    const owner = await bearer(name, 'jared', { role: 'owner', name: 'Jared' })
    const app = await bearer(name, 'workbus-app', { kind: 'workload' })
    const op = { ...app, 'x-board-profile': 'op;name="Operator";handle="op"' }

    const first = await api(name, 'POST', '/messages', { channel: 'dm/op', text: 'hello from the operator' }, op)
    expect(first.status).toBe(201)
    expect(first.body.message.by).toEqual({ actor: OP, principal: 'worker:workbus-app', profile: 'op' })
    expect(first.body.message.author).toMatchObject({ kind: 'agent', handle: 'op', name: 'Operator' })
    expect((await api(name, 'GET', '/me', undefined, op)).body).toMatchObject({ actor: OP, handle: 'op', name: 'Operator', profile: 'op' })

    // @op settles to the seat, not to a candidate.
    const asked = await api(name, 'POST', '/messages', { re: first.body.message.id, text: '@op make two tasks' }, owner)
    expect(asked.body.mentions).toEqual([{ written: '@op', actor: { id: OP, handle: 'op', name: 'Operator' }, candidates: [] }])
    expect(asked.body.message.text).toBe('@[' + OP + '] make two tasks')
    const task = await api(name, 'POST', '/tasks', { channel: 'eng', text: 'a task for the operator', for: OP }, owner)
    expect(task.status).toBe(201)

    // Renamed and re-handled: the same actor, shown anew everywhere, with an actor.seen event.
    const renamed = { ...app, 'x-board-profile': 'op;name="Ops Lead";handle="ops"' }
    expect((await api(name, 'GET', '/me', undefined, renamed)).body).toMatchObject({ actor: OP, handle: 'ops', name: 'Ops Lead' })
    const after = await api(name, 'POST', '/messages', { channel: 'dm/op', text: 'renamed' }, renamed)
    expect(after.body.message.by.actor).toBe(OP)
    const actors = (await api(name, 'GET', '/actors', undefined, owner)).body.actors as { id: string; handle: string; name: string }[]
    expect(actors.filter((actor) => actor.id.startsWith('worker:workbus-app'))).toEqual([expect.objectContaining({ id: OP, handle: 'ops', name: 'Ops Lead' })])
    const events = (await api(name, 'GET', '/events?all=true&last=20', undefined, owner)).body.events as { type: string; payload: { actor?: string; handle?: string; name?: string } }[]
    expect(events.some((event) => event.type === 'actor.seen' && event.payload.actor === OP && event.payload.handle === 'ops' && event.payload.name === 'Ops Lead')).toBe(true)

    // Its history: the old message shows the new name, and the stored mention still names it.
    const thread = (await api(name, 'GET', '/messages/' + first.body.message.id, undefined, owner)).body
    expect(thread.message.author).toMatchObject({ handle: 'ops', name: 'Ops Lead' })
    expect(thread.replies[0].text).toBe('@[' + OP + '] make two tasks')
    // Its follows (it started the thread), its DM, and its task (found by the new handle).
    const follows = (await api(name, 'GET', '/follows', undefined, renamed)).body.follows as { thread: string }[]
    expect(follows.map((follow) => follow.thread)).toContain(first.body.message.id)
    expect((await api(name, 'GET', '/messages?channel=dm/op', undefined, renamed)).body.messages.map((m: { text: string }) => m.text)).toEqual(['hello from the operator', '@[' + OP + '] make two tasks', 'renamed'])
    expect((await api(name, 'GET', '/tasks?for=ops', undefined, owner)).body.tasks.map((t: { message: { id: string } }) => t.message.id)).toEqual([task.body.task.id])
    // And a mention of what it's called now.
    expect((await api(name, 'POST', '/messages', { channel: 'eng', text: 'thanks @ops' }, owner)).body.mentions[0].actor.id).toBe(OP)
    // @op is free again: nothing has it.
    expect((await api(name, 'POST', '/messages', { channel: 'eng', text: 'hi @op' }, owner)).body.mentions[0]).toMatchObject({ actor: null, candidates: [] })

    // A request that leaves the name and handle out keeps them: the claim sticks.
    const bare = await api(name, 'POST', '/messages', { channel: 'eng', text: 'bare' }, { ...app, 'x-board-profile': 'op' })
    expect(bare.body.message.author).toMatchObject({ handle: 'ops', name: 'Ops Lead' })
  })

  it('a handle is one actor\'s across people and agents: a claim on a taken one is refused, and says which is free', async () => {
    const name = freshBoard('profile-taken')
    const owner = await bearer(name, 'jared', { role: 'owner', name: 'Jared' })
    const app = await bearer(name, 'workbus-app', { kind: 'workload' })
    const other = await bearer(name, 'other-app', { kind: 'workload' })
    expect((await api(name, 'POST', '/messages', { channel: 'eng', text: 'hi' }, owner)).status).toBe(201)
    expect((await api(name, 'POST', '/messages', { channel: 'eng', text: 'op here' }, { ...app, 'x-board-profile': 'op;name="Operator";handle="op"' })).status).toBe(201)

    // Another profile of the same principal, another principal's profile of the same key, and a person's handle.
    const sibling = await api(name, 'POST', '/messages', { channel: 'eng', text: 'mine' }, { ...app, 'x-board-profile': 'eng;name="Engineer";handle="op"' })
    expect(sibling.status).toBe(409)
    expect(sibling.body.error).toMatchObject({ code: 'handle_taken', message: '@op is taken by Operator. Try @ops.' })
    const stranger = await api(name, 'POST', '/messages', { channel: 'eng', text: 'mine' }, { ...other, 'x-board-profile': 'op;handle="op"' })
    expect(stranger.status).toBe(409)
    expect(stranger.body.error.code).toBe('handle_taken')
    // Its own +op is its own actor, which can't write as the other's: only a profile's principal sets its handle and name.
    const own = await api(name, 'POST', '/messages', { channel: 'eng', text: 'my own op' }, { ...other, 'x-board-profile': 'op;name="Not the Operator"' })
    expect(own.body.message.by.actor).toBe('worker:other-app+op')
    expect((await api(name, 'GET', '/actors', undefined, owner)).body.actors.find((a: { id: string }) => a.id === OP)).toMatchObject({ handle: 'op', name: 'Operator' })
    const person = await api(name, 'GET', '/me', undefined, { ...app, 'x-board-profile': 'eng;handle="jared"' })
    expect(person.status).toBe(409)
    expect(person.body.error.message).toBe('@jared is taken by Jared. Try @jareds.')
    // The suggestion skips what's taken too.
    expect((await api(name, 'POST', '/messages', { channel: 'eng', text: 'ops' }, { ...app, 'x-board-profile': 'ops;handle="ops"' })).status).toBe(201)
    expect((await api(name, 'GET', '/me', undefined, { ...app, 'x-board-profile': 'eng;handle="op"' })).body.error.message).toBe('@op is taken by Operator. Try @op2.')

    // What a handle can be.
    for (const bad of ['me', 'you', 'Op/x', '-op', 'op-', 'a'.repeat(33), '']) {
      const refused = await api(name, 'GET', '/me', undefined, { ...app, 'x-board-profile': 'eng;handle=' + JSON.stringify(bad) })
      expect(refused.status, bad).toBe(400)
      expect(refused.body.error.code, bad).toBe('invalid_profile')
    }
    // Hyphens and digits are fine: @eng-lead, @eng2.
    for (const good of ['eng-lead', 'eng2']) expect((await api(name, 'GET', '/me', undefined, { ...app, 'x-board-profile': 'lead;handle="' + good + '"' })).body.handle, good).toBe(good)
    // A display name is any text, up to 64 characters, apart from the key.
    expect((await api(name, 'GET', '/me', undefined, { ...app, 'x-board-profile': 'eng;name="Ada, the engineer"' })).body).toMatchObject({ actor: 'worker:workbus-app+eng', name: 'Ada, the engineer' })
    expect((await api(name, 'GET', '/me', undefined, { ...app, 'x-board-profile': 'eng;name="' + 'x'.repeat(65) + '"' })).status).toBe(400)
  })

  it("the binding's as({ key, name, handle }) claims the same way, and as('name') still works", async () => {
    const name = freshBoard('profile-binding')
    const caller: Caller = { principal: { id: 'worker:workbus-app', kind: 'deployment', handle: 'workbus-app', name: 'workbus-app', facts: null, expiresAt: null }, profile: null, narrow: null, via: 'binding' }
    const board = new Board({ env: env as never, name, caller, mount: mountOf(name), region: 'xx' } as never)
    const ada = board.as({ key: 'ada', name: 'Ada Lovelace', handle: 'ada' })
    const posted = (await ada.post('eng', 'hello')) as { message: { by: { actor: string }; author: { handle: string; name: string } } }
    expect(posted.message.by.actor).toBe('worker:workbus-app+ada')
    expect(posted.message.author).toMatchObject({ handle: 'ada', name: 'Ada Lovelace' })
    const legacy = (await board.as('Fixer').post('eng', 'as before')) as { message: { by: { actor: string }; author: { handle: string; name: string } } }
    expect(legacy.message.by.actor).toBe('worker:workbus-app+fixer')
    expect(legacy.message.author).toMatchObject({ handle: 'workbus-app/fixer', name: 'Fixer' })
    await expect(board.as({ key: 'bob', name: 'Bob', handle: 'ada' }).post('eng', 'taken')).rejects.toThrow('@ada is taken by Ada Lovelace. Try @adas.')
    expect(() => board.as({ key: 'Ada Lovelace', name: 'x' })).toThrow("a profile's key")
  })

  it('a schedule a profile made sends as the profile is now: a rename since keeps its name and handle', async () => {
    const time = clock()
    try {
      const name = freshBoard('profile-schedule')
      const owner = await bearer(name, 'jared', { role: 'owner' })
      const app = await bearer(name, 'workbus-app', { kind: 'workload' })
      const made = await api(name, 'POST', '/schedules', { channel: 'eng', text: 'check in', in: '1m' }, { ...app, 'x-board-profile': 'op;name="Operator";handle="op"' })
      expect(made.status).toBe(201)
      expect((await api(name, 'POST', '/messages', { channel: 'eng', text: 'renamed' }, { ...app, 'x-board-profile': 'op;name="Ops Lead";handle="ops"' })).status).toBe(201)
      time.advance(61_000)
      await runDurableObjectAlarm(ledgerOf(name) as unknown as DurableObjectStub)
      const sent = (await api(name, 'GET', '/messages?channel=eng', undefined, owner)).body.messages as { text: string; by: { actor: string }; author: { handle: string; name: string } }[]
      expect(sent.find((message) => message.text === 'check in')).toMatchObject({ by: { actor: OP }, author: { handle: 'ops', name: 'Ops Lead' } })
    } finally {
      time.restore()
    }
  })
})

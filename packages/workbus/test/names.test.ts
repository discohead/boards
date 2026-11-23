// A person sets their own display name (PATCH /me): it wins over the token's name everywhere the
// board shows them, their profiles keep their own names, and only a person may set one.
import { describe, expect, it } from 'vitest'
import { api, freshBoard, ledgerOf, mountOf, person, tokenFor } from './helpers.ts'
import type { Caller } from '../src/ledger/core.ts'

const deployment: Caller = { principal: { id: 'worker:deploys', kind: 'deployment', handle: 'deploys', name: 'deploys', facts: { issuer: 'binding', claims: {} }, expiresAt: null }, profile: null, narrow: null, via: 'binding' }

describe('display names', () => {
  it("a person's name shows on /me, /actors, their messages, and the feed's actor, and their profile keeps its own", async () => {
    const name = freshBoard('names')
    const token = 'Bearer ' + (await tokenFor(name, 'jared', { claims: { name: 'jared@example.test' } }))
    const auth = { authorization: token }
    const before = await api(name, 'POST', '/messages', { channel: 'general', text: 'before the name' }, auth)
    expect(before.body.message.author.name).toBe('jared@example.test')
    const asProfile = await api(name, 'POST', '/messages', { channel: 'general', text: 'as a profile' }, { ...auth, 'x-board-profile': 'reviewer' })
    expect(asProfile.status).toBe(201)

    const set = await api(name, 'PATCH', '/me', { name: '  Jared  ' }, auth)
    expect(set.status).toBe(200)
    expect(set.body).toMatchObject({ actor: 'workbus:user:jared', name: 'Jared', handle: 'jared' })

    expect((await api(name, 'GET', '/me', undefined, auth)).body.name).toBe('Jared')
    const actors = (await api(name, 'GET', '/actors', undefined, auth)).body.actors as { id: string; name: string }[]
    expect(actors.find((actor) => actor.id === 'workbus:user:jared')?.name).toBe('Jared')
    expect(actors.find((actor) => actor.id === 'workbus:user:jared+reviewer')?.name).toBe('reviewer')
    // An old message shows the name its author has now; a new one too, and a later token's name doesn't undo it.
    const thread = (await api(name, 'GET', '/messages/' + before.body.message.id, undefined, auth)).body
    expect(thread.message.author.name).toBe('Jared')
    const after = await api(name, 'POST', '/messages', { channel: 'general', text: 'after the name' }, auth)
    expect(after.body.message.author.name).toBe('Jared')
    // The change is an actor.seen event (in the feed with all=true), and later events carry the name.
    const events = (await api(name, 'GET', '/events?all=true&last=10', undefined, auth)).body.events as { type: string; payload: { actor?: string; name?: string }; actor?: { name: string } }[]
    expect(events.some((event) => event.type === 'actor.seen' && event.payload.actor === 'workbus:user:jared' && event.payload.name === 'Jared')).toBe(true)
    expect(events.at(-1)?.actor?.name).toBe('Jared')
    // The profile still writes as itself.
    const profileAgain = await api(name, 'POST', '/messages', { channel: 'general', text: 'profile again' }, { ...auth, 'x-board-profile': 'reviewer' })
    expect(profileAgain.body.message.author.name).toBe('reviewer')
  })

  it('only a person sets one, without a profile, and a name must be 1 to 64 characters with no control characters', async () => {
    const name = freshBoard('names-refused')
    const auth = { authorization: 'Bearer ' + (await tokenFor(name, 'jared')) }
    const byWorker = await ledgerOf(name).call(deployment, 'setName', { name: 'Deploys' }, mountOf(name))
    expect(byWorker.ok).toBe(false)
    if (!byWorker.ok) expect(byWorker.failure.status).toBe(403)
    const workload = 'Bearer ' + (await tokenFor(name, 'ci-bot', { claims: { kind: 'workload' } }))
    expect((await api(name, 'PATCH', '/me', { name: 'CI' }, { authorization: workload })).status).toBe(403)
    expect((await api(name, 'PATCH', '/me', { name: 'Reviewer' }, { ...auth, 'x-board-profile': 'reviewer' })).status).toBe(400)
    for (const bad of ['', '   ', 'x'.repeat(65), 'tab\there', 'new\nline', '\u0000nul']) expect((await api(name, 'PATCH', '/me', { name: bad }, auth)).status, JSON.stringify(bad)).toBe(400)
    expect((await api(name, 'PATCH', '/me', { name: 'é'.repeat(64) }, auth)).status).toBe(200)
    expect((await api(name, 'PATCH', '/me', { name: 'ok', extra: 1 }, auth)).status).toBe(400)
    // The direct call checks the caller, not the shape: a person through the Ledger is let in.
    expect((await ledgerOf(name).call(person('ada'), 'setName', { name: 'Ada' }, mountOf(name))).ok).toBe(true)
  })
})

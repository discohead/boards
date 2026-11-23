// A proposal's change, read (GET /docs/proposals/:id): what applying it would do, with nothing written.
// A new doc's path and body; a change's doc, its body now, and the body it would have; stale when a
// whole body was proposed against an older revision; a thread that isn't a proposal is 404.
import { describe, expect, it } from 'vitest'
import { api, freshBoard } from './helpers.ts'

describe('a proposal, read', () => {
  it('a new doc: its path and body; a change: the body now and the body it would have, by section or whole', async () => {
    const name = freshBoard('doc-proposals')
    const made = await api(name, 'POST', '/docs', { channel: 'org/seats', slug: 'dana', body: '# Dana\n\nWrites docs.\n', propose: true, note: 'a hire' })
    expect(made.status).toBe(201)
    const asked = await api(name, 'GET', '/docs/proposals/' + made.body.proposal.id)
    expect(asked.status).toBe(200)
    expect(asked.body).toMatchObject({ kind: 'new', path: 'org/seats/dana', proposed: '# Dana\n\nWrites docs.\n' })

    const doc = (await api(name, 'POST', '/docs', { channel: 'org/teams', slug: 'eng', body: '# Eng\n\nWe build.\n\n## Seats\n\nop, ada\n' })).body.message
    const revision = doc.revision === undefined ? doc.doc.revision : doc.revision
    const rev = String(doc.doc?.revision ?? revision)
    const whole = await api(name, 'POST', '/docs/' + doc.id + '/edit', { revision: rev, body: '# Eng\n\nWe build.\n\n## Seats\n\nop, ada, dana\n', propose: true })
    expect(whole.status).toBe(200)
    const read = await api(name, 'GET', '/docs/proposals/' + whole.body.proposal.id)
    expect(read.body).toMatchObject({ kind: 'edit', path: 'org/teams/eng', doc: doc.id, stale: false, current: '# Eng\n\nWe build.\n\n## Seats\n\nop, ada\n', proposed: '# Eng\n\nWe build.\n\n## Seats\n\nop, ada, dana\n' })

    const bySection = await api(name, 'POST', '/docs/' + doc.id + '/edit', { revision: rev, edits: [{ section: 'eng/seats', text: 'op, ada, rhea' }], propose: true })
    expect(bySection.status).toBe(200)
    const sections = await api(name, 'GET', '/docs/proposals/' + bySection.body.proposal.id)
    expect(sections.body.proposed).toContain('op, ada, rhea')
    expect(sections.body.current).toContain('op, ada\n')

    // Nothing was written: the doc is as it was.
    expect((await api(name, 'GET', '/docs/' + doc.id)).body.body).toBe('# Eng\n\nWe build.\n\n## Seats\n\nop, ada\n')

    // The doc changes: the whole-body proposal is stale (applying it would be refused).
    const now = (await api(name, 'GET', '/docs/' + doc.id)).body.doc.revision
    expect((await api(name, 'POST', '/docs/' + doc.id + '/edit', { revision: now, edits: [{ section: 'eng', text: 'We build things.' }] })).status).toBe(200)
    expect((await api(name, 'GET', '/docs/proposals/' + whole.body.proposal.id)).body.stale).toBe(true)

    // A task that isn't a proposal, and a message that isn't there.
    const plain = (await api(name, 'POST', '/tasks', { channel: 'org/teams', text: 'not a proposal' })).body.task.id
    expect((await api(name, 'GET', '/docs/proposals/' + plain)).body.error.code).toBe('not_a_proposal')
    expect((await api(name, 'GET', '/docs/proposals/99999')).status).toBe(404)
  })

  it("a proposal in a private channel is 404 to someone who isn't a party to it, as any of its reads", async () => {
    const name = freshBoard('doc-proposals-dm')
    const { tokenFor } = await import('./helpers.ts')
    const owner = { authorization: 'Bearer ' + (await tokenFor(name, 'jared', { claims: { role: 'owner' } })) }
    const member = { authorization: 'Bearer ' + (await tokenFor(name, 'mallory', { claims: { role: 'member' } })) }
    const made = await api(name, 'POST', '/docs', { channel: 'dm/ada', slug: 'zebra', body: '# Zebra\n', propose: true }, owner)
    expect(made.status).toBe(201)
    expect((await api(name, 'GET', '/docs/proposals/' + made.body.proposal.id, undefined, owner)).body.path).toBe('dm/ada/zebra')
    const refused = await api(name, 'GET', '/docs/proposals/' + made.body.proposal.id, undefined, member)
    expect(refused.status).toBe(404)
    expect(JSON.stringify(refused.body)).not.toContain('zebra')
  })

  it("someone who can't read the channel can't read the proposal", async () => {
    const name = freshBoard('doc-proposals-private')
    const made = await api(name, 'POST', '/docs', { channel: 'org/seats', slug: 'eve', body: '# Eve\n', propose: true })
    const { tokenFor } = await import('./helpers.ts')
    const narrowed = { authorization: 'Bearer ' + (await tokenFor(name, 'mallory', { claims: { role: 'member' } })), 'x-board-can': 'eng/=read' }
    expect((await api(name, 'GET', '/docs/proposals/' + made.body.proposal.id, undefined, narrowed)).status).toBe(404)
  })
})

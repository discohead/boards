// Docs: a thread with a body, edited by section and checked per section. Each test is something a
// user can observe through the HTTP API.
import { describe, expect, it } from 'vitest'
import { parseDoc, applyEdit, bodyOf, type SectionEdit } from '../src/ledger/doctext.ts'
import { api, freshBoard, ledgerOf, mountOf, person, rows } from './helpers.ts'

const DOC = [
  'Runbook for deploys.',
  '',
  '# Deploy',
  '',
  'How we ship.',
  '',
  '## Rollback',
  '',
  'Revert the release.',
  '',
  '## Canary',
  '',
  'Ship to 1% first.',
  '',
  '# Monitoring',
  '',
  'Watch the dashboards.',
  '',
].join('\n')

async function create(name: string, slug = 'deploy', body = DOC, extra: Record<string, unknown> = {}) {
  const made = await api(name, 'POST', '/docs', { channel: 'docs/runbooks', slug, body, ...extra })
  expect(made.status, JSON.stringify(made.body)).toBe(201)
  return made.body.message as { id: string; text: string; labels: Record<string, string>; doc: { revision: string; path: string; sections: { key: string }[] } }
}
const read = async (name: string, id: string, query = '') => (await api(name, 'GET', '/docs/' + id + query)).body
const editDoc = (name: string, id: string, body: Record<string, unknown>, headers: Record<string, string> = {}) => api(name, 'POST', '/docs/' + id + '/edit', body, headers)

describe('a doc', () => {
  it('is a thread whose root holds its body, found by its board.doc label and its path', async () => {
    const name = freshBoard('doc-create')
    const doc = await create(name)
    expect(doc.text).toBe(DOC)
    expect(doc.labels['board.doc']).toBe('docs/runbooks/deploy')
    expect(doc.doc.path).toBe('docs/runbooks/deploy')
    expect(doc.doc.sections.map((section) => section.key)).toEqual(['deploy', 'deploy/rollback', 'deploy/canary', 'monitoring'])
    const listed = await api(name, 'GET', '/threads?label=board.doc')
    expect(listed.body.threads.map((thread: { message: { id: string } }) => thread.message.id)).toEqual([doc.id])
    const at = await api(name, 'GET', '/docs?path=docs/runbooks/deploy')
    expect(at.body.doc.id).toBe(doc.id)
    expect(at.body.body).toBe(DOC)
    expect((await api(name, 'POST', '/docs', { channel: 'docs/runbooks', slug: 'deploy', body: 'again' })).body.error.code).toBe('slug_taken')
  })

  it('takes edit in its channel to create or edit, and post to comment or propose', async () => {
    const name = freshBoard('doc-access')
    const doc = await create(name)
    const narrowed = { 'x-board-can': '*=read,post' }
    expect((await api(name, 'POST', '/docs', { channel: 'docs/runbooks', slug: 'other', body: 'x' }, narrowed)).status).toBe(403)
    expect((await editDoc(name, doc.id, { revision: doc.doc.revision, edits: [{ section: 'monitoring', text: 'x\n' }] }, narrowed)).status).toBe(403)
    expect((await api(name, 'POST', '/messages', { re: doc.id, text: 'a comment' }, narrowed)).status).toBe(201)
    expect((await editDoc(name, doc.id, { revision: doc.doc.revision, edits: [{ section: 'monitoring', text: 'x\n' }] }, { 'x-board-can': '*=read,post,edit' })).status).toBe(200)
  })

  it("refuses the plain edit op on its root, and lets anyone who may edit it delete it", async () => {
    const name = freshBoard('doc-edit-op')
    const doc = await create(name)
    const plain = await api(name, 'POST', '/messages/' + doc.id + '/edit', { text: 'overwrite' })
    expect(plain.body.error.code).toBe('use_edit_doc')
    const other = await api(name, 'POST', '/messages/' + doc.id + '/delete', {}, { authorization: 'Bearer ' + (await import('./helpers.ts').then((h) => h.tokenFor(name, 'ada'))) })
    expect(other.status).toBe(200)
    expect((await api(name, 'GET', '/docs/' + doc.id)).body.error.code).toBe('doc_not_found')
  })
})

describe('the edit permission on the wire', () => {
  it("shows edit where a token has it without manage, and leaves it out where manage implies it", async () => {
    const name = freshBoard('doc-wire')
    expect((await api(name, 'GET', '/me')).body.can['*']).toEqual(['read', 'post', 'react', 'label', 'sync', 'manage'])
    expect((await api(name, 'GET', '/me', undefined, { 'x-board-can': 'docs/=read,post,edit' })).body.can).toEqual({ 'docs/': ['read', 'post', 'edit'] })
  })
})

describe('section edits', () => {
  it('two edits to different sections from the same revision both land', async () => {
    const name = freshBoard('doc-two')
    const doc = await create(name)
    const r = doc.doc.revision
    expect((await editDoc(name, doc.id, { revision: r, edits: [{ section: 'deploy/rollback', text: '\nRevert, then page.\n\n' }] })).status).toBe(200)
    expect((await editDoc(name, doc.id, { revision: r, edits: [{ section: 'monitoring', text: '\nWatch p99.\n' }] })).status).toBe(200)
    const now = await read(name, doc.id)
    expect(now.body).toContain('Revert, then page.')
    expect(now.body).toContain('Watch p99.')
  })

  it('two edits to the same section from the same revision: one lands, the other is section_conflict', async () => {
    const name = freshBoard('doc-same')
    const doc = await create(name)
    const r = doc.doc.revision
    expect((await editDoc(name, doc.id, { revision: r, edits: [{ section: 'deploy/rollback', text: '\nFirst.\n\n' }] })).status).toBe(200)
    const second = await editDoc(name, doc.id, { revision: r, edits: [{ section: 'deploy/rollback', text: '\nSecond.\n\n' }] })
    expect(second.status).toBe(409)
    expect(second.body.error.code).toBe('section_conflict')
    expect(second.body.error.data.section).toBe('deploy/rollback')
    expect((await read(name, doc.id)).body).toContain('First.')
  })

  it("a parent's own text and a child section don't conflict; a rewrite of the parent's subtree does", async () => {
    const name = freshBoard('doc-nested')
    const doc = await create(name)
    const r = doc.doc.revision
    // Only a child changes: the parent's own text is as it was at r.
    expect((await editDoc(name, doc.id, { revision: r, edits: [{ section: 'deploy/rollback', text: '\nRevert.\n\n' }] })).status).toBe(200)
    const rewrite = await editDoc(name, doc.id, { revision: r, edits: [{ section: 'deploy', subtree: true, text: '\nAll new.\n\n' }] })
    expect(rewrite.body.error?.code).toBe('section_conflict')
    const removal = await editDoc(name, doc.id, { revision: r, edits: [{ remove: 'deploy' }] })
    expect(removal.body.error?.code).toBe('section_conflict')
    expect((await editDoc(name, doc.id, { revision: r, edits: [{ section: 'deploy', text: '\nHow we ship, briefly.\n\n' }] })).status).toBe(200)
    const fresh = (await read(name, doc.id)).doc.revision
    expect((await editDoc(name, doc.id, { revision: fresh, edits: [{ section: 'deploy', subtree: true, text: '\nAll new.\n\n### Only\n\nOne step.\n' }] })).status).toBe(200)
    expect((await read(name, doc.id)).doc.sections.map((section: { key: string }) => section.key)).toEqual(['deploy', 'deploy/only', 'monitoring'])
  })

  it('inserts, renames, and removes sections, and refuses a heading smuggled into own text', async () => {
    const name = freshBoard('doc-shape')
    const doc = await create(name)
    let r = doc.doc.revision
    const inserted = await editDoc(name, doc.id, { revision: r, edits: [{ after: 'deploy/canary', text: '## Smoke\n\nRun the smoke tests.\n' }] })
    expect(inserted.status).toBe(200)
    r = inserted.body.revision
    expect((await editDoc(name, doc.id, { revision: r, edits: [{ section: 'monitoring', title: 'Observability' }] })).status).toBe(200)
    r = (await read(name, doc.id)).doc.revision
    expect((await editDoc(name, doc.id, { revision: r, edits: [{ remove: 'deploy/smoke' }] })).status).toBe(200)
    expect((await read(name, doc.id)).doc.sections.map((section: { key: string }) => section.key)).toEqual(['deploy', 'deploy/rollback', 'deploy/canary', 'observability'])
    const smuggled = await editDoc(name, doc.id, { revision: (await read(name, doc.id)).doc.revision, edits: [{ section: 'observability', text: '# Escape\n' }] })
    expect(smuggled.body.error.code).toBe('invalid_edit')
  })
})

describe('whole-body edits', () => {
  it('a stale whole body is revision_conflict; with merge, sections changed on one side merge and both-sides changes name their sections', async () => {
    const name = freshBoard('doc-merge')
    const doc = await create(name)
    const r = doc.doc.revision
    await editDoc(name, doc.id, { revision: r, edits: [{ section: 'monitoring', text: '\nWatch p99.\n' }] })
    const mine = DOC.replace('Revert the release.', 'Revert the release, then page.')
    expect((await editDoc(name, doc.id, { revision: r, body: mine })).body.error.code).toBe('revision_conflict')
    const merged = await editDoc(name, doc.id, { revision: r, body: mine, merge: true })
    expect(merged.status).toBe(200)
    expect(merged.body.merged).toBe(true)
    const now = (await read(name, doc.id)).body
    expect(now).toContain('then page.')
    expect(now).toContain('Watch p99.')
    const clash = await editDoc(name, doc.id, { revision: r, body: DOC.replace('Watch the dashboards.', 'Watch logs.'), merge: true })
    expect(clash.body.error.code).toBe('merge_conflict')
    expect(clash.body.error.data.sections).toEqual(['monitoring'])
  })

  it('merges against a base text when the editor holds no revision', async () => {
    const name = freshBoard('doc-base')
    const doc = await create(name)
    await editDoc(name, doc.id, { revision: doc.doc.revision, edits: [{ section: 'deploy/canary', text: '\nShip to 5%.\n\n' }] })
    const theirs = DOC.replace('How we ship.', 'How we ship, from a file.')
    const merged = await editDoc(name, doc.id, { base: DOC, body: theirs, merge: true })
    expect(merged.status).toBe(200)
    const now = (await read(name, doc.id)).body
    expect(now).toContain('from a file.')
    expect(now).toContain('Ship to 5%.')
  })
})

describe('history', () => {
  it('reads every revision back exactly, across snapshots, and lists and diffs the edits', async () => {
    const name = freshBoard('doc-history')
    const doc = await create(name)
    const bodies = new Map<string, string>([[doc.doc.revision, DOC]])
    let r = doc.doc.revision
    const keys = ['deploy', 'deploy/rollback', 'deploy/canary', 'monitoring']
    for (let i = 0; i < 70; i++) {
      const key = keys[i % keys.length]!
      const done = await editDoc(name, doc.id, { revision: r, edits: [{ section: key, text: '\nEdit ' + i + ' of ' + key + '.\n\n' }] })
      expect(done.status, JSON.stringify(done.body)).toBe(200)
      r = done.body.revision
      bodies.set(r, (await read(name, doc.id)).body)
    }
    const snapshots = await rows(name, "select count(*) as n from doc_versions where kind = 'snapshot'")
    expect(Number(snapshots[0]!.n)).toBe(2)
    for (const [rev, body] of bodies) expect((await read(name, doc.id, '?revision=' + rev)).body).toBe(body)
    const history = (await api(name, 'GET', '/docs/' + doc.id + '/history')).body
    expect(history.edits).toHaveLength(71)
    expect(history.edits[0].kind).toBe('created')
    expect(history.edits[5].sections).toEqual([{ section: 'deploy', op: 'edited' }])
    const revs = [...bodies.keys()]
    const diff = (await api(name, 'GET', '/docs/' + doc.id + '/diff?from=' + revs[0] + '&to=' + revs[2])).body
    expect(diff.sections.map((section: { section: string; change: string }) => section.section + ':' + section.change)).toEqual(['deploy:edited', 'deploy/rollback:edited'])
    const section = (await read(name, doc.id, '?section=monitoring')).section
    expect(section.text).toBe(bodies.get(r)!.slice(bodies.get(r)!.indexOf('# Monitoring\n') + '# Monitoring\n'.length))
  })

  it('an 18 KB doc edited 1,000 times grows the log by its edits, not by its size', async () => {
    const name = freshBoard('doc-growth')
    const paragraph = 'Lorem ipsum dolor sit amet, consectetur adipiscing elit. '.repeat(40) + '\n\n'
    const body = Array.from({ length: 8 }, (_, i) => '## Part ' + i + '\n\n' + paragraph).join('')
    expect(body.length).toBeGreaterThan(18_000)
    const ledger = ledgerOf(name)
    const caller = person()
    const made = await ledger.call(caller, 'createDoc', { channel: 'docs', slug: 'big', body }, mountOf(name))
    if (!made.ok) throw new Error(JSON.stringify(made.failure))
    const id = made.value.message.id as string
    let r = made.value.message.doc.revision as string
    const [{ bytes: before }] = await rows<{ bytes: number }>(name, 'select sum(length(payload) + length(facets)) as bytes from events')
    for (let i = 0; i < 1000; i++) {
      const done = await ledger.call(caller, 'editDoc', { id, revision: r, edits: [{ section: 'part-' + (i % 8), text: '\nEdit number ' + i + '.\n\n' + paragraph }] }, mountOf(name))
      if (!done.ok) throw new Error(JSON.stringify(done.failure))
      r = done.value.revision
    }
    const [{ bytes: after }] = await rows<{ bytes: number }>(name, 'select sum(length(payload) + length(facets)) as bytes from events')
    const grew = after - before
    const naive = 1000 * body.length * 3
    console.log('[docs growth] body ' + body.length + ' B; 1,000 edits grew the log ' + grew + ' B (' + Math.round(grew / 1000) + ' B an edit); storing the body three times would be ' + naive + ' B')
    // Each edit carries its one changed section (about 2.3 KB) and its facets; a snapshot every 64 edits adds the body.
    expect(grew).toBeLessThan(1000 * 4_000 + 16 * (body.length + 1000))
    expect(grew * 10).toBeLessThan(naive)
  }, 120_000)
})

describe('concurrent section edits', () => {
  it('never diverge from a sequential model: distinct sections both land, the same one lands once', async () => {
    const name = freshBoard('doc-model')
    const doc = await create(name)
    let model = parseDoc(DOC)
    let r = doc.doc.revision
    let seed = 7
    const random = (n: number) => ((seed = (seed * 1103515245 + 12345) % 2147483648), seed % n)
    for (let round = 0; round < 60; round++) {
      const keys = model.filter((section) => section.level > 0).map((section) => section.key)
      const a: SectionEdit = { section: keys[random(keys.length)]!, text: '\nA' + round + '.\n\n' }
      const b: SectionEdit = { section: keys[random(keys.length)]!, text: '\nB' + round + '.\n\n' }
      const first = await editDoc(name, doc.id, { revision: r, edits: [a] })
      expect(first.status).toBe(200)
      model = applyEdit(model, a)
      const second = await editDoc(name, doc.id, { revision: r, edits: [b] })
      if ((a as { section: string }).section === (b as { section: string }).section) expect(second.body.error?.code).toBe('section_conflict')
      else {
        expect(second.status).toBe(200)
        model = applyEdit(model, b)
      }
      const now = await read(name, doc.id)
      expect(now.body).toBe(bodyOf(model))
      r = now.doc.revision
    }
  }, 60_000)
})

describe('proposals', () => {
  it('someone without edit proposes; completing the task applies the edit as proposed', async () => {
    const name = freshBoard('doc-propose')
    const doc = await create(name)
    const narrowed = { 'x-board-can': '*=read,post' }
    const proposed = await editDoc(name, doc.id, { revision: doc.doc.revision, edits: [{ section: 'deploy/canary', text: '\nShip to 5% first.\n\n' }], propose: true, note: 'Canary at 1% misses regressions.' }, narrowed)
    expect(proposed.status, JSON.stringify(proposed.body)).toBe(200)
    const task = proposed.body.proposal
    expect(task.labels['board.doc.proposal']).toBe(doc.id)
    expect(task.task.state).toBe('ready')
    expect((await read(name, doc.id)).body).toBe(DOC)
    expect((await api(name, 'GET', '/messages/' + doc.id)).body.message.doc.proposals).toEqual([task.id])
    const claim = (await api(name, 'POST', '/tasks/' + task.id + '/claim', {})).body.claim
    expect((await api(name, 'POST', '/tasks/' + task.id + '/complete', { epoch: claim.epoch, token: claim.token })).status).toBe(200)
    expect((await read(name, doc.id)).body).toContain('Ship to 5% first.')
    const history = (await api(name, 'GET', '/docs/' + doc.id + '/history')).body.edits
    expect(history.at(-1).proposedBy).toBe('boards:user:jared')
  })

  it('a proposal overtaken by an edit to its section fails to complete and stays open', async () => {
    const name = freshBoard('doc-overtaken')
    const doc = await create(name)
    const proposed = await editDoc(name, doc.id, { revision: doc.doc.revision, edits: [{ section: 'deploy/canary', text: '\nMine.\n\n' }], propose: true })
    await editDoc(name, doc.id, { revision: doc.doc.revision, edits: [{ section: 'deploy/canary', text: '\nTheirs.\n\n' }] })
    const task = proposed.body.proposal
    const claim = (await api(name, 'POST', '/tasks/' + task.id + '/claim', {})).body.claim
    const done = await api(name, 'POST', '/tasks/' + task.id + '/complete', { epoch: claim.epoch, token: claim.token })
    expect(done.body.error.code).toBe('section_conflict')
    expect((await api(name, 'GET', '/messages/' + task.id)).body.message.task.state).toBe('claimed')
    expect((await read(name, doc.id)).body).toContain('Theirs.')
  })
})

describe('templates, comments, links, and moves', () => {
  it('makes a doc from another, filling its placeholders and recording where it came from', async () => {
    const name = freshBoard('doc-template')
    const template = await create(name, 'postmortem', '# {{title}}\n\nBy {{author}} on {{date}}.\n\n## Impact\n\n{{impact}}\n', { labels: { template: 'true', kind: 'postmortem' } })
    const made = await api(name, 'POST', '/docs', { channel: 'docs/incidents', slug: 'checkout-outage', from: template.id, labels: { status: 'draft' } })
    expect(made.status).toBe(201)
    const doc = made.body.message
    expect(doc.text).toMatch(/^# Checkout outage\n\nBy jared on \d{4}-\d{2}-\d{2}\.\n\n## Impact\n\n\{\{impact\}\}\n$/)
    expect(doc.labels).toMatchObject({ kind: 'postmortem', status: 'draft', 'board.doc.from': template.id })
    expect(doc.labels.template).toBeUndefined()
    const fromIt = await api(name, 'GET', '/threads?label=board.doc.from=' + template.id)
    expect(fromIt.body.threads.map((thread: { message: { id: string } }) => thread.message.id)).toEqual([doc.id])
  })

  it("comments on a section carry its key, and say when it's gone", async () => {
    const name = freshBoard('doc-comments')
    const doc = await create(name)
    const comment = await api(name, 'POST', '/messages', { re: doc.id, text: 'Is 1% enough?', section: 'deploy/canary' })
    expect(comment.status).toBe(201)
    expect(comment.body.message.labels['board.doc.section']).toBe('deploy/canary')
    expect(comment.body.message.section).toEqual({ key: 'deploy/canary', detached: false })
    expect((await api(name, 'POST', '/messages', { re: doc.id, text: 'x', section: 'nope' })).body.error.code).toBe('section_not_found')
    expect((await api(name, 'POST', '/messages', { re: doc.id, text: 'x', labels: { 'board.doc.section': 'deploy' } })).body.error.code).toBe('reserved_label')
    await editDoc(name, doc.id, { revision: doc.doc.revision, edits: [{ remove: 'deploy/canary' }] })
    const reply = (await api(name, 'GET', '/messages/' + doc.id)).body.replies[0]
    expect(reply.section).toEqual({ key: 'deploy/canary', detached: true })
  })

  it('lists backlinks by ID, so they survive a move, and a moved doc takes its comments along', async () => {
    const name = freshBoard('doc-links')
    const doc = await create(name)
    const mention = await api(name, 'POST', '/messages', { channel: 'ops', text: 'See [[docs/runbooks/deploy#rollback]] before you ship.' })
    const byId = await api(name, 'POST', '/messages', { channel: 'ops', text: 'Also [[#' + doc.id + ']].' })
    await api(name, 'POST', '/messages', { re: doc.id, text: 'a comment' })
    const before = (await api(name, 'GET', '/docs/' + doc.id + '/backlinks')).body.backlinks.map((link: { id: string }) => link.id)
    expect(before).toEqual([mention.body.message.id, byId.body.message.id])
    const moved = await api(name, 'POST', '/docs/' + doc.id + '/move', { channel: 'docs/ops', slug: 'shipping' })
    expect(moved.status, JSON.stringify(moved.body)).toBe(200)
    expect(moved.body.doc.path).toBe('docs/ops/shipping')
    expect((await api(name, 'GET', '/docs/' + doc.id + '/backlinks')).body.backlinks.map((link: { id: string }) => link.id)).toEqual(before)
    expect((await api(name, 'GET', '/docs?path=docs/runbooks/deploy')).body.error.code).toBe('doc_not_found')
    expect((await api(name, 'GET', '/docs?path=docs/ops/shipping')).body.doc.id).toBe(doc.id)
    const thread = (await api(name, 'GET', '/messages/' + doc.id)).body
    expect(thread.message.channel).toBe('docs/ops')
    expect(thread.replies.map((reply: { channel: string }) => reply.channel)).toEqual(['docs/ops'])
    const after = await api(name, 'POST', '/messages', { channel: 'ops', text: 'Now at [[docs/ops/shipping]].' })
    expect((await api(name, 'GET', '/docs/' + doc.id + '/backlinks')).body.backlinks.map((link: { id: string }) => link.id)).toEqual([...before, after.body.message.id])
  })
})

describe('the feed', () => {
  it("matches a doc edit on the title and headings of what changed, not on the body", async () => {
    const name = freshBoard('doc-feed')
    const doc = await create(name)
    const head = (await api(name, 'GET', '/events?last=1')).body.cursor
    await editDoc(name, doc.id, { revision: doc.doc.revision, edits: [{ section: 'deploy/canary', text: '\nShip to 5%.\n\n' }] })
    await editDoc(name, doc.id, { revision: doc.doc.revision, edits: [{ section: 'deploy/rollback', text: '\nRevert.\n\n' }] })
    const rollback = (await api(name, 'GET', '/events?after=' + head + '&text=Rollback')).body.events.map((event: { type: string; payload: { changes: { section: string }[] } }) => event.type + ':' + event.payload.changes.map((change) => change.section).join(','))
    expect(rollback).toEqual(['doc.edited:deploy/rollback'])
    const all = (await api(name, 'GET', '/events?after=' + head + '&channel=docs/runbooks')).body.events.map((event: { type: string }) => event.type)
    expect(all).toEqual(['doc.edited', 'doc.edited'])
    const facets = await rows<{ facets: string }>(name, "select facets from events where type = 'doc.edited'")
    for (const row of facets) expect(row.facets.length).toBeLessThan(1500)
  })
})

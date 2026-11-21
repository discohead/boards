// Docs kept in step with a platform's copy (the suite's sync keeps docsync/<board>): what's written
// on the board goes there as the doc's whole body, its comments don't, an import merges by section
// against what the platform's copy was before, both changing one section makes a task and keeps the
// board's version, and an import isn't written back.
import { describe, expect, it } from 'vitest'
import { api, freshBoard, until } from './helpers.ts'
import { sentOf, webhook } from './sync-helpers.ts'

const settle = (ms = 800) => new Promise((resolve) => setTimeout(resolve, ms))
const docWrites = (name: string) => sentOf(name).filter((entry) => entry.op === 'doc')
const BODY = '# Deploy\n\nHow we ship.\n\n## Canary\n\nFive percent.\n\n## Rollback\n\nBy version ID.\n'

async function made(name: string, body = BODY, channel = 'docsync/' + name) {
  const created = await api(name, 'POST', '/docs', { channel, slug: 'deploy', body })
  expect(created.status).toBe(201)
  return created.body.message as { id: string; doc: { revision: string } }
}

describe('docs on a sync', () => {
  it("writes the doc's whole body to the platform on each change, and never its comments", async () => {
    const name = freshBoard('docsync')
    const doc = await made(name)
    await until(() => docWrites(name).some((entry) => entry.text === BODY), 'the doc, written')
    const edited = await api(name, 'POST', '/docs/' + doc.id + '/edit', { revision: doc.doc.revision, edits: [{ section: 'deploy/canary', text: '\nTen percent.\n\n' }] })
    expect(edited.status).toBe(200)
    const after = BODY.replace('Five percent.', 'Ten percent.')
    await until(() => docWrites(name).some((entry) => entry.event === 'edited' && entry.text === after), 'the edit, written')
    const comment = await api(name, 'POST', '/messages', { re: doc.id, section: 'deploy/canary', text: 'why ten?' })
    expect(comment.status).toBe(201)
    await settle()
    expect(sentOf(name).filter((entry) => entry.op !== 'doc')).toEqual([])
    expect(docWrites(name).at(-1)).toMatchObject({ target: 'test:' + name + ':doc:' + doc.id, path: 'docsync/' + name + '/deploy', text: after })
  })

  it('writes nothing for a doc outside the channels it keeps', async () => {
    const name = freshBoard('docsync-outside')
    await made(name, BODY, 'elsewhere')
    await settle()
    expect(docWrites(name)).toEqual([])
  })

  it('says where a moved doc was', async () => {
    const name = freshBoard('docsync-move')
    const doc = await made(name)
    await until(() => docWrites(name).length, 'the doc, written')
    expect((await api(name, 'POST', '/docs/' + doc.id + '/move', { channel: 'docsync/' + name + '/ops', slug: 'deploy' })).status).toBe(200)
    await until(() => docWrites(name).some((entry) => entry.event === 'moved'), 'the move, written')
    expect(docWrites(name).find((entry) => entry.event === 'moved')).toMatchObject({ from: 'docsync/' + name + '/deploy', path: 'docsync/' + name + '/ops/deploy' })
  })

  it("imports the platform's copy as a merge, keeping what the board changed meanwhile, and writes back the merge, not the import", async () => {
    const name = freshBoard('docsync-in')
    const channel = 'docsync/' + name
    expect((await webhook(name, [{ id: 'f1', kind: 'docfile', thread: 'f', message: 'v1', channel, slug: 'deploy', before: null, after: BODY }])).status).toBe(200)
    const found = await until(async () => (await api(name, 'GET', '/docs?path=' + encodeURIComponent(channel + '/deploy'))).body.doc, 'the imported doc')
    // The board changes Rollback; the platform, from the copy it had, changes Canary.
    const ours = await api(name, 'POST', '/docs/' + found.id + '/edit', { revision: found.revision, edits: [{ section: 'deploy/rollback', text: '\nBy version ID, within an hour.\n' }] })
    expect(ours.status).toBe(200)
    const theirs = BODY.replace('Five percent.', 'Ten percent.')
    expect((await webhook(name, [{ id: 'f2', kind: 'docfile', thread: 'f', message: 'v2', channel, slug: 'deploy', before: BODY, after: theirs }])).status).toBe(200)
    const both = BODY.replace('Five percent.', 'Ten percent.').replace('By version ID.', 'By version ID, within an hour.')
    await until(async () => (await api(name, 'GET', '/docs/' + found.id)).body.body === both, 'both changes, merged')
    await settle()
    // What came from the platform isn't written back to it; what the board wrote is, and so is the
    // merge, which holds what the platform's copy lacks.
    await until(() => docWrites(name).some((entry) => entry.text === both), 'the merge, written back')
    expect(docWrites(name).map((entry) => entry.text)).not.toContain(BODY)
    expect(docWrites(name).map((entry) => entry.text)).toContain(both.replace('Ten percent.', 'Five percent.'))
  })

  it("keeps the board's version and makes a task when both changed the same section", async () => {
    const name = freshBoard('docsync-conflict')
    const channel = 'docsync/' + name
    const doc = await made(name)
    const ours = await api(name, 'POST', '/docs/' + doc.id + '/edit', { revision: doc.doc.revision, edits: [{ section: 'deploy/canary', text: '\nOne percent.\n\n' }] })
    expect(ours.status).toBe(200)
    const theirs = BODY.replace('Five percent.', 'Ten percent.')
    expect((await webhook(name, [{ id: 'c1', kind: 'docfile', thread: 'f', message: 'v2', channel, slug: 'deploy', before: BODY, after: theirs }])).status).toBe(200)
    const task = await until(async () => (await api(name, 'GET', '/tasks?channel=' + encodeURIComponent(channel))).body.tasks?.[0], 'the task')
    expect(task.message.text).toContain('[[' + channel + '/deploy]] both changed ' + '\u0060deploy/canary\u0060')
    expect((await api(name, 'GET', '/docs/' + doc.id)).body.body).toBe(BODY.replace('Five percent.', 'One percent.'))
  })

  it("makes a mirror only from a sync's import, and only its imports change it", async () => {
    const name = freshBoard('docsync-mirror')
    const channel = 'docsync/' + name
    expect((await api(name, 'POST', '/docs', { channel, slug: 'mine', body: BODY, mirror: true })).body.error).toMatchObject({ code: 'mirror_needs_sync' })
    expect((await webhook(name, [{ id: 'm1', kind: 'docfile', thread: 'm', message: 'v1', channel, slug: 'handbook', before: null, after: BODY, mirror: true }])).status).toBe(200)
    const found = await until(async () => (await api(name, 'GET', '/docs?path=' + encodeURIComponent(channel + '/handbook'))).body.doc, 'the mirror')
    expect(found.source).toBe('test')
    const refused = await api(name, 'POST', '/docs/' + found.id + '/edit', { revision: found.revision, edits: [{ section: 'deploy/canary', text: '\nOne percent.\n\n' }] })
    expect([refused.status, refused.body.error.code]).toEqual([409, 'doc_mirrored'])
    const next = BODY.replace('Five percent.', 'Ten percent.')
    expect((await webhook(name, [{ id: 'm2', kind: 'docfile', thread: 'm', message: 'v2', channel, slug: 'handbook', before: null, after: next, mirror: true }])).status).toBe(200)
    await until(async () => (await api(name, 'GET', '/docs/' + found.id)).body.body === next, 'the mirror, changed by its import')
  })
})

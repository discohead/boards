// One thread, two faces (design/workbus.md §4.1): a task's thread can gain a body, and a doc's thread
// can become a task. The board keys both by the thread's root; every read keeps both faces.
import { describe, expect, it } from 'vitest'
import { api, freshBoard, rows, tokenFor } from './helpers.ts'

const as = async (name: string, sub: string, method: string, path: string, body?: unknown, headers: Record<string, string> = {}) =>
  api(name, method, path, body, { authorization: 'Bearer ' + (await tokenFor(name, sub)), ...headers })
const ok = async (name: string, sub: string, method: string, path: string, body?: unknown, headers: Record<string, string> = {}) => {
  const answer = await as(name, sub, method, path, body, headers)
  expect(answer.status, method + ' ' + path + ' ' + JSON.stringify(answer.body)).toBeLessThan(300)
  return answer.body
}
const BODY = '# Login fails\n\nUsers see a 500.\n\n## Steps\n\nSign in twice.\n\n## Fix\n\nTBD.\n'

type View = { id: string; labels: Record<string, string>; task?: { state: string }; doc?: { path: string; revision: string } }
/** Both faces on a message view: its task's state and its doc's path. */
const faces = (view: View) => ({ id: view.id, state: view.task?.state, task: view.labels['board.task'], path: view.doc?.path, doc: view.labels['board.doc'] })

/** Every read a thread with both faces answers, as one summary: each one shows both, or says what it lost. */
async function everyRead(name: string, id: string, state: string, path: string, revisions: string[]) {
  const both = { id, state, task: state, path, doc: path }
  expect(faces((await ok(name, 'jared', 'GET', '/messages/' + id)).message), 'GET /messages/:id').toEqual(both)
  const tasks = (await ok(name, 'jared', 'GET', '/tasks?state=all')).tasks as { message: View }[]
  expect(tasks.map((entry) => faces(entry.message)), 'GET /tasks').toContainEqual(both)
  const doc = await ok(name, 'jared', 'GET', '/docs/' + id)
  expect(doc.doc.path, 'GET /docs/:id').toBe(path)
  expect((await ok(name, 'jared', 'GET', '/docs?path=' + path)).doc.id, 'GET /docs?path=').toBe(id)
  const history = await ok(name, 'jared', 'GET', '/docs/' + id + '/history')
  expect(history.edits.map((edit: { revision: string }) => edit.revision), 'history').toEqual(revisions)
  for (const revision of revisions) expect((await as(name, 'jared', 'GET', '/docs/' + id + '?revision=' + revision)).status, 'revision ' + revision).toBe(200)
  if (revisions.length > 1) expect((await ok(name, 'jared', 'GET', '/docs/' + id + '/diff?from=' + revisions[0])).sections.length, 'diff').toBeGreaterThan(0)
  for (const query of ['label=board.task=' + state, 'label=board.doc', 'label=board.doc=' + path, 'text=login'])
    expect(((await ok(name, 'jared', 'GET', '/threads?' + query)).threads as { message: View }[]).map((thread) => faces(thread.message)), '/threads?' + query).toContainEqual(both)
  const events = (await ok(name, 'jared', 'GET', '/events?last=100')).events as { type: string; message?: View }[]
  const latest = events.filter((event) => event.message?.id === id).at(-1)!
  expect(faces(latest.message!), 'the feed').toEqual(both)
}

describe('a thread with both faces', () => {
  it("a doc's thread becomes a task, and every read keeps both", async () => {
    const name = freshBoard('faces-doc-task')
    const made = await ok(name, 'jared', 'POST', '/docs', { channel: 'eng/issues', slug: 'login', body: BODY })
    const id = made.message.id as string
    const created = made.message.doc.revision as string
    const task = await ok(name, 'jared', 'POST', '/tasks', { re: id })
    expect(faces(task.task)).toEqual({ id, state: 'ready', task: 'ready', path: 'eng/issues/login', doc: 'eng/issues/login' })
    await everyRead(name, id, 'ready', 'eng/issues/login', [created])

    // Claimed: the claim answers both faces, and next finds it in its channel's queue.
    const claimed = await ok(name, 'ada', 'POST', '/tasks/claim', { channel: 'eng/issues', from: ['workbus:user:jared'] })
    expect(faces(claimed.task)).toEqual({ id, state: 'claimed', task: 'claimed', path: 'eng/issues/login', doc: 'eng/issues/login' })
    // Its body is edited by section while it's claimed; a proposal is its own task.
    const edited = await ok(name, 'ada', 'POST', '/docs/' + id + '/edit', { revision: created, edits: [{ section: 'login-fails/fix', text: '\nRetry the session.\n' }] })
    const proposed = await ok(name, 'bob', 'POST', '/docs/' + id + '/edit', { revision: edited.revision, edits: [{ section: 'login-fails/steps', text: '\nSign in three times.\n' }], propose: true }, { 'x-board-can': '*=read,post' })
    const proposal = proposed.proposal.id as string
    const pclaim = await ok(name, 'jared', 'POST', '/tasks/' + proposal + '/claim', {})
    await ok(name, 'jared', 'POST', '/tasks/' + proposal + '/complete', { epoch: pclaim.claim.epoch, token: pclaim.claim.token })
    const now = (await ok(name, 'jared', 'GET', '/docs/' + id)) as { doc: { revision: string }; body: string }
    expect(now.body).toContain('Sign in three times.')
    expect(now.body).toContain('Retry the session.')
    await everyRead(name, id, 'claimed', 'eng/issues/login', [created, edited.revision, now.doc.revision])
    // Comments on a section are replies of the task's thread.
    await ok(name, 'bob', 'POST', '/messages', { re: id, section: 'login-fails/fix', text: 'Does a retry hide it?' })
    // Completed, it stays a doc; moved, it stays a task.
    await ok(name, 'ada', 'POST', '/tasks/' + id + '/complete', { epoch: claimed.claim.epoch, token: claimed.claim.token, result: 'fixed' })
    await ok(name, 'jared', 'POST', '/docs/' + id + '/move', { channel: 'eng/done' })
    expect((await rows(name, "select term from terms where message = ? and term like 'l:board.task=%'", Number(id))).map((row) => row.term)).toEqual(['l:board.task=completed'])
    await everyRead(name, id, 'completed', 'eng/done/login', [created, edited.revision, now.doc.revision])
    const thread = await ok(name, 'jared', 'GET', '/messages/' + id)
    expect(thread.replies.length).toBe(1)
  })

  it("a task's thread gains a body, and every read keeps both", async () => {
    const name = freshBoard('faces-task-doc')
    const made = await ok(name, 'jared', 'POST', '/tasks', { channel: 'eng/issues', text: 'Login fails for some users.', labels: { area: 'auth' } })
    const id = made.task.id as string
    await ok(name, 'ada', 'POST', '/messages', { re: id, text: 'I see it too.' })
    const claimed = await ok(name, 'jared', 'POST', '/tasks/' + id + '/claim', {})
    const doc = await ok(name, 'jared', 'POST', '/docs', { re: id, slug: 'login', body: BODY })
    expect(faces(doc.message)).toEqual({ id, state: 'claimed', task: 'claimed', path: 'eng/issues/login', doc: 'eng/issues/login' })
    expect(doc.message.labels.area).toBe('auth')
    const created = doc.message.doc.revision as string
    expect((await rows(name, "select term from terms where message = ? and term like 'l:board.task=%'", Number(id))).map((row) => row.term)).toEqual(['l:board.task=claimed'])
    await everyRead(name, id, 'claimed', 'eng/issues/login', [created])
    const history = await ok(name, 'jared', 'GET', '/docs/' + id + '/history')
    expect(history.edits[0]).toMatchObject({ revision: created, kind: 'created' })
    // Before it was a doc, it had no body to read.
    expect((await as(name, 'jared', 'GET', '/docs/' + id + '?revision=' + id)).body.error.code).toBe('invalid_revision')
    // It's a doc now: its body changes by section, and its old comment is a comment.
    expect((await as(name, 'jared', 'POST', '/messages/' + id + '/edit', { text: 'plain' })).body.error.code).toBe('use_edit_doc')
    const edited = await ok(name, 'jared', 'POST', '/docs/' + id + '/edit', { revision: created, edits: [{ section: 'login-fails/fix', text: '\nRetry the session.\n' }] })
    expect((await rows(name, "select term from terms where message = ? and term like 'l:board.task%' order by term", Number(id))).map((row) => row.term)).toEqual(['l:board.task', 'l:board.task=claimed'])
    await ok(name, 'jared', 'POST', '/tasks/' + id + '/complete', { epoch: claimed.claim.epoch, token: claimed.claim.token })
    await everyRead(name, id, 'completed', 'eng/issues/login', [created, edited.revision])
    expect((await ok(name, 'jared', 'GET', '/messages/' + id)).replies.map((reply: { text: string }) => reply.text)).toEqual(['I see it too.'])
  })

  it("a new body from someone else holds a claimed task, as an edit would; the root's own text doesn't", async () => {
    const name = freshBoard('faces-hold')
    const first = (await ok(name, 'bob', 'POST', '/tasks', { channel: 'eng', text: '# Deploy\n\nShip it.\n' })).task.id as string
    const second = (await ok(name, 'bob', 'POST', '/tasks', { channel: 'eng', text: '# Rollback\n\nUndo it.\n' })).task.id as string
    await ok(name, 'bob', 'POST', '/tasks/' + first + '/claim', {})
    await ok(name, 'bob', 'POST', '/tasks/' + second + '/claim', {})
    const kept = await ok(name, 'ada', 'POST', '/docs', { re: first, slug: 'deploy' })
    expect(kept.message.task.state).toBe('claimed')
    expect(kept.message.text).toBe('# Deploy\n\nShip it.\n')
    expect((await rows(name, "select term from terms where message = ? and term like 'l:board.task=%'", Number(first))).map((row) => row.term)).toEqual(['l:board.task=claimed'])
    const changed = await ok(name, 'ada', 'POST', '/docs', { re: second, slug: 'rollback', body: '# Rollback\n\nUndo it, then tell ops.\n' })
    expect(changed.message.task).toMatchObject({ state: 'blocked' })
  })

  it('refuses a body for a reply, a doc already, a slug taken, or a thread and a channel at once', async () => {
    const name = freshBoard('faces-refuse')
    const root = (await ok(name, 'jared', 'POST', '/messages', { channel: 'eng', text: 'A thread.' })).message.id as string
    const reply = (await ok(name, 'jared', 'POST', '/messages', { re: root, text: 'A reply.' })).message.id as string
    await ok(name, 'jared', 'POST', '/docs', { channel: 'eng', slug: 'taken', body: '# Taken\n' })
    const refused = async (body: Record<string, unknown>) => (await as(name, 'jared', 'POST', '/docs', body)).body.error.code
    expect(await refused({ re: reply, slug: 'a' })).toBe('invalid_request')
    expect(await refused({ re: root, slug: 'taken' })).toBe('slug_taken')
    expect(await refused({ re: root, channel: 'eng', slug: 'b' })).toBe('invalid_request')
    await ok(name, 'jared', 'POST', '/docs', { re: root, slug: 'thread' })
    expect(await refused({ re: root, slug: 'again' })).toBe('already_a_doc')
  })
})

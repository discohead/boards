// GitHub's half of docs kept in step with Markdown files, against a fake GitHub API: which pushes
// mean a doc changed, the board call an import makes from the file before and after, and the commit
// the courier makes for a doc written on the board.
//   node --test test/sync/github-docs.node-test.ts
import assert from 'node:assert/strict'
import { createHmac } from 'node:crypto'
import { test } from 'node:test'
import { githubProvider } from '../../src/sync/github.ts'

const SECRET = 'gh-secret'
const REPO = 'acme/web'
const files = new Map<string, string>() // ref:path -> text
const shas = new Map<string, string>()
const requests: { method: string; path: string; body?: any }[] = []

globalThis.fetch = (async (input: string, init: RequestInit = {}) => {
  const url = new URL(input)
  const method = init.method ?? 'GET'
  const body = init.body ? JSON.parse(String(init.body)) : undefined
  requests.push({ method, path: url.pathname + url.search, body })
  const found = url.pathname.match(/^\/repos\/acme\/web\/contents\/(.+)$/)
  if (url.pathname === '/repos/acme/web' && method === 'GET') return Response.json({ default_branch: 'trunk' })
  if (!found) return new Response('{}', { status: 404 })
  const path = decodeURIComponent(found[1]!)
  if (method === 'GET') {
    const text = files.get(url.searchParams.get('ref') + ':' + path)
    if (text === undefined) return new Response('{"message":"Not Found"}', { status: 404 })
    const content = Buffer.from(text).toString('base64').replace(/(.{60})/g, '$1\n')
    return Response.json({ type: 'file', sha: shas.get(path) ?? 'sha-' + path, content, encoding: 'base64' })
  }
  if (method === 'PUT') {
    files.set(body.branch + ':' + path, Buffer.from(body.content, 'base64').toString('utf8'))
    shas.set(path, 'sha-' + requests.length)
    return Response.json({ content: { sha: shas.get(path) } }, { status: 201 })
  }
  if (method === 'DELETE') {
    files.delete(body.branch + ':' + path)
    return Response.json({})
  }
  return new Response('{}', { status: 405 })
}) as typeof fetch

const provider = githubProvider({ webhookSecret: { get: async () => SECRET }, repos: {}, token: async () => 'token', botUserId: '42', apiBase: 'https://api.test', docs: { [REPO]: { dir: 'docs', channel: 'web/docs', branch: 'main' } } })

function push(payload: Record<string, unknown>) {
  const body = JSON.stringify({ repository: { full_name: REPO, default_branch: 'main' }, sender: { id: 7, login: 'ada' }, ...payload })
  return new Request('https://board.test/webhooks/github', { method: 'POST', headers: { 'x-github-event': 'push', 'x-github-delivery': 'd1', 'x-hub-signature-256': 'sha256=' + createHmac('sha256', SECRET).update(body).digest('hex') }, body })
}

test('a push to the branch names each Markdown file under the docs dir that changed, once', async () => {
  const got = await provider.receive(push({ ref: 'refs/heads/main', before: 'a'.repeat(40), after: 'b'.repeat(40), commits: [{ added: ['docs/runbooks/deploy.md', 'src/x.ts'], modified: ['README.md'] }, { modified: ['docs/runbooks/deploy.md', 'docs/notes.txt'] }] }), { key: 'github' })
  assert.deepEqual(got.events.map((event) => [event.thread, event.channel, (event.event as any).path]), [['github:acme/web:file:docs/runbooks/deploy.md', 'github:acme/web', 'docs/runbooks/deploy.md']])
})

test("a push to another branch, or the app's own, means nothing", async () => {
  assert.equal((await provider.receive(push({ ref: 'refs/heads/feature', commits: [{ modified: ['docs/a.md'] }] }), { key: 'github' })).events.length, 0)
  assert.equal((await provider.receive(push({ ref: 'refs/heads/main', sender: { id: 42 }, commits: [{ modified: ['docs/a.md'] }] }), { key: 'github' })).events.length, 0)
})

test("an import merges the file's new text against what it was before, as the doc at its path", async () => {
  files.set('b1:docs/runbooks/deploy.md', '# Deploy\n\nold\n')
  files.set('a1:docs/runbooks/deploy.md', '# Deploy\n\nnew ✓\n')
  const calls: [string, any][] = []
  const call = async (method: string, body: any) => {
    calls.push([method, body])
    if (method === 'docAt') return { doc: { id: '9', revision: '20' } }
    return { revision: '21' }
  }
  const [event] = (await provider.receive(push({ ref: 'refs/heads/main', before: 'b1', after: 'a1', commits: [{ modified: ['docs/runbooks/deploy.md'] }] }), { key: 'github' })).events
  await provider.import(event!.event, { key: 'github', call, rootOf: async () => null, attempt: 1, last: false })
  assert.deepEqual(calls, [
    ['docAt', { path: 'web/docs/runbooks/deploy', depth: 1 }],
    ['editDoc', { id: '9', base: '# Deploy\n\nold\n', body: '# Deploy\n\nnew ✓\n', merge: true }],
  ])
})

test("a file that can't be a doc's path is left out", async () => {
  const [event] = (await provider.receive(push({ ref: 'refs/heads/main', before: 'b1', after: 'a1', commits: [{ modified: ['docs/Runbooks/Deploy Plan.md'] }] }), { key: 'github' })).events
  const calls: string[] = []
  assert.equal(await provider.import(event!.event, { key: 'github', call: async (method) => calls.push(method), rootOf: async () => null, attempt: 1, last: false }), null)
  assert.deepEqual(calls, [])
})

test('a doc written on the board is committed to its file, once, and a move deletes the old one', async () => {
  files.set('main:docs/runbooks/deploy.md', '# Deploy\n\nold\n')
  requests.length = 0
  const doc = (path: string, revision: string) => ({ id: '9', path, title: 'Deploy', revision })
  await provider.doc!({ target: 'github:acme/web:doc:9', event: 'edited', doc: doc('web/docs/runbooks/deploy', '30'), body: '# Deploy\n\nfrom the board ✓\n', by: 'user:ada' }, { key: 'github' })
  const put = requests.find((request) => request.method === 'PUT')!
  assert.equal(put.path, '/repos/acme/web/contents/docs/runbooks/deploy.md')
  assert.equal(put.body.sha, 'sha-docs/runbooks/deploy.md')
  assert.equal(put.body.branch, 'main')
  assert.match(put.body.message, /revision 30, user:ada/)
  assert.equal(files.get('main:docs/runbooks/deploy.md'), '# Deploy\n\nfrom the board ✓\n')
  // The retry guard: the file says it already.
  requests.length = 0
  await provider.doc!({ target: 'github:acme/web:doc:9', event: 'edited', doc: doc('web/docs/runbooks/deploy', '30'), body: '# Deploy\n\nfrom the board ✓\n' }, { key: 'github' })
  assert.deepEqual(requests.map((request) => request.method), ['GET'])
  await provider.doc!({ target: 'github:acme/web:doc:9', event: 'moved', doc: doc('web/docs/ops/deploy', '31'), body: '# Deploy\n\nfrom the board ✓\n', from: 'web/docs/runbooks/deploy', to: 'web/docs/ops/deploy' }, { key: 'github' })
  assert.equal(files.has('main:docs/runbooks/deploy.md'), false)
  assert.equal(files.get('main:docs/ops/deploy.md'), '# Deploy\n\nfrom the board ✓\n')
})

test('docs in the docs channel and below are kept; others are not', () => {
  assert.equal(provider.docTarget!('web/docs/runbooks/deploy', 'github'), 'github:acme/web:doc')
  assert.equal(provider.docTarget!('web/docs/deploy', 'github'), 'github:acme/web:doc')
  assert.equal(provider.docTarget!('web/docsy/deploy', 'github'), null)
})

test("with no branch named, both ways use the repo's default branch", async () => {
  const unnamed = githubProvider({ webhookSecret: { get: async () => SECRET }, repos: {}, token: async () => 'token', botUserId: '42', apiBase: 'https://api.test', docs: { [REPO]: { dir: 'docs', channel: 'web/docs' } } })
  const pushTo = async (ref: string) => (await unnamed.receive(push({ ref, repository: { full_name: REPO, default_branch: 'trunk' }, before: 'b1', after: 'a1', commits: [{ modified: ['docs/x.md'] }] }), { key: 'github' })).events.length
  assert.equal(await pushTo('refs/heads/trunk'), 1)
  assert.equal(await pushTo('refs/heads/main'), 0)
  requests.length = 0
  await unnamed.doc!({ target: 'github:acme/web:doc:9', event: 'edited', doc: { id: '9', path: 'web/docs/x', title: 'X', revision: '3' }, body: '# X\n' }, { key: 'github' })
  assert.equal(requests.find((request) => request.method === 'PUT')!.body.branch, 'trunk')
  assert.equal(files.get('trunk:docs/x.md'), '# X\n')
})

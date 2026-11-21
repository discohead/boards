// Notion's half of docs kept in step with pages, against a fake Notion API: which webhooks mean a
// page changed, a page imported as a mirror or merged two-way against what Notion last held, and a
// board write sent back as one replacement per changed section.
//   node --test test/sync/notion.node-test.ts
import assert from 'node:assert/strict'
import { createHmac } from 'node:crypto'
import { test } from 'node:test'
import { docText, notionProvider, pageText, sectionUpdates, SYNCED_LABEL } from '../../src/sync/notion.ts'

const SECRET = 'secret_verify'
const MIRROR = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
const TWO = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb'
type Page = { title: string; markdown: string }
const notionPages = new Map<string, Page>()
const requests: { method: string; path: string; body?: any }[] = []

globalThis.fetch = (async (input: string, init: RequestInit = {}) => {
  const url = new URL(input)
  const method = init.method ?? 'GET'
  const body = init.body ? JSON.parse(String(init.body)) : undefined
  requests.push({ method, path: url.pathname, body })
  assert.equal((init.headers as Record<string, string>)['notion-version'], '2026-03-11')
  const found = url.pathname.match(/^\/v1\/pages\/([0-9a-f]+)(\/markdown)?$/)
  const page = found ? notionPages.get(found[1]!) : undefined
  if (!found || !page) return new Response('{"code":"object_not_found"}', { status: 404 })
  if (!found[2] && method === 'GET') return Response.json({ object: 'page', id: found[1], url: 'https://app.notion.com/p/' + found[1], properties: { Name: { id: 'title', type: 'title', title: [{ plain_text: page.title }] } } })
  if (!found[2] && method === 'PATCH') {
    page.title = body.properties.Name.title.map((part: any) => part.text.content).join('')
    return Response.json({ object: 'page' })
  }
  if (method === 'GET') return Response.json({ object: 'page_markdown', id: found[1], markdown: page.markdown, truncated: false, unknown_block_ids: [] })
  if (body.type === 'update_content') {
    const warnings: unknown[] = []
    for (const update of body.update_content.content_updates) {
      if (!page.markdown.includes(update.old_str)) warnings.push({ code: 'no_match' })
      else page.markdown = page.markdown.replace(update.old_str, update.new_str)
    }
    return Response.json({ object: 'page_markdown', markdown: page.markdown, warnings })
  }
  if (body.type === 'replace_content') {
    page.markdown = body.replace_content.new_str
    return Response.json({ object: 'page_markdown', markdown: page.markdown })
  }
  return new Response('{}', { status: 400 })
}) as typeof fetch

const provider = notionProvider({ token: 'ntn_test', webhookSecret: SECRET, apiBase: 'https://notion.test', pages: { 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa': { channel: 'handbook', slug: 'mirror' }, [TWO]: { channel: 'handbook', slug: 'deploy', twoWay: true } } })

const webhook = (payload: unknown, sign = true) => {
  const body = JSON.stringify(payload)
  return new Request('https://board.test/webhooks/notion', { method: 'POST', headers: sign ? { 'x-notion-signature': 'sha256=' + createHmac('sha256', SECRET).update(body).digest('hex') } : {}, body })
}
const changed = (page: string, id = 'ev-' + page) => ({ id, type: 'page.content_updated', entity: { id: page, type: 'page' }, data: {} })

/** A board, as the provider calls it: one doc at a path, with labels and revisions. */
function board() {
  const calls: [string, any][] = []
  let doc: { id: string; revision: string; body: string; labels: Record<string, string> } | null = null
  const bodies = new Map<string, string>()
  const call = async (method: string, input: any): Promise<any> => {
    calls.push([method, input])
    if (method === 'docAt') {
      if (!doc) throw Object.assign(new Error('doc_not_found'), { code: 'doc_not_found' })
      return { doc: { id: doc.id, revision: doc.revision }, body: doc.body }
    }
    if (method === 'createDoc') {
      doc = { id: '5', revision: '5', body: input.body, labels: {} }
      bodies.set('5', input.body)
      return { message: { id: '5' } }
    }
    if (method === 'editDoc') {
      const next = String(Number(doc!.revision) + 1)
      doc!.revision = next
      doc!.body = input.body
      bodies.set(next, input.body)
      return { revision: next }
    }
    if (method === 'message') return { message: { labels: doc!.labels } }
    if (method === 'doc') return { body: input.revision ? bodies.get(input.revision) : doc!.body }
    if (method === 'label') {
      Object.assign(doc!.labels, input.set)
      return {}
    }
    throw new Error('unexpected ' + method)
  }
  return { call, calls, get doc() { return doc }, set: (body: string, labels: Record<string, string> = {}) => { doc = { id: '5', revision: '9', body, labels }; bodies.set('9', body) }, bodies }
}
const tools = (call: any) => ({ key: 'notion', call, rootOf: async () => null, attempt: 1, last: false })

test('a new subscription is answered, a signed change to a page it keeps is one event, anything else none', async () => {
  assert.deepEqual((await provider.receive(webhook({ verification_token: 'secret_new' }, false), { key: 'notion' })).events, [])
  assert.equal((await provider.receive(webhook(changed(MIRROR), false), { key: 'notion' })).response?.status, 401)
  const tampered = webhook(changed(MIRROR))
  const forged = new Request(tampered.url, { method: 'POST', headers: tampered.headers, body: JSON.stringify(changed(TWO)) })
  assert.equal((await provider.receive(forged, { key: 'notion' })).response?.status, 401)
  const got = await provider.receive(webhook(changed('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa')), { key: 'notion' })
  assert.deepEqual(got.events.map((event) => [event.id, event.thread, event.event]), [['ev-aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'notion:page:' + MIRROR, { kind: 'page', page: MIRROR }]])
  assert.deepEqual((await provider.receive(webhook(changed('cccccccccccccccccccccccccccccccc')), { key: 'notion' })).events, [])
  assert.deepEqual((await provider.receive(webhook({ ...changed(MIRROR), type: 'comment.created' }), { key: 'notion' })).events, [])
})

test('with no webhook secret yet, only the verification request is answered', async () => {
  const bare = notionProvider({ token: 'ntn_test', pages: {} })
  assert.equal((await bare.receive(webhook({ verification_token: 'secret_new' }, false), { key: 'notion' })).response, undefined)
  assert.equal((await bare.receive(webhook(changed(MIRROR)), { key: 'notion' })).response?.status, 401)
})

test('a mirror is made from the page, then is what the page says', async () => {
  notionPages.set(MIRROR, { title: 'Handbook', markdown: '## Hours\n\nNine to five.\n' })
  const b = board()
  await provider.import({ kind: 'page', page: MIRROR }, tools(b.call))
  assert.deepEqual(b.calls.at(-1), ['createDoc', { channel: 'handbook', slug: 'mirror', body: '# Handbook\n\n## Hours\n\nNine to five.\n', mirror: true }])
  notionPages.get(MIRROR)!.markdown = '## Hours\n\nTen to six.\n'
  await provider.import({ kind: 'page', page: MIRROR }, tools(b.call))
  assert.deepEqual(b.calls.at(-1), ['editDoc', { id: '5', revision: '5', body: '# Handbook\n\n## Hours\n\nTen to six.\n' }])
})

test("two-way: Notion's change merges against what Notion last held, and that becomes the base when the doc agrees", async () => {
  const held = '# Deploy\n\n## Canary\n\nFive percent.\n\n## Rollback\n\nBy version ID.\n'
  const b = board()
  b.set(held.replace('By version ID.', 'By version ID, within an hour.'), { [SYNCED_LABEL]: '9' })
  b.bodies.set('9', held)
  notionPages.set(TWO, { title: 'Deploy', markdown: '## Canary\n\nTen percent.\n\n## Rollback\n\nBy version ID.' })
  await provider.import({ kind: 'page', page: TWO }, tools(b.call))
  const edit = b.calls.find(([method]) => method === 'editDoc')!
  assert.deepEqual(edit[1], { id: '5', base: held, body: '# Deploy\n\n## Canary\n\nTen percent.\n\n## Rollback\n\nBy version ID.\n', merge: true })
  // The doc took Notion's text whole here (the fake doesn't merge): it agrees, so it's the base now.
  assert.equal(b.doc!.labels[SYNCED_LABEL], b.doc!.revision)
})

test('a board write goes back as one replacement per changed section, and the title as the page title', async () => {
  notionPages.set(TWO, { title: 'Deploy', markdown: 'How we ship.\n\n## Canary\n\nFive percent.\n\n## Rollback\n\nBy version ID.\n' })
  const b = board()
  b.set('x')
  requests.length = 0
  await provider.doc!({ target: 'notion:' + TWO + ':5', event: 'edited', doc: { id: '5', path: 'handbook/deploy', title: 'Shipping', revision: '12' }, body: '# Shipping\n\nHow we ship.\n\n## Canary\n\nTen percent.\n\n## Rollback\n\nBy version ID.\n' }, { key: 'notion', call: b.call })
  const writes = requests.filter((request) => request.method === 'PATCH')
  assert.deepEqual(writes.map((request) => request.body.type ?? 'title'), ['title', 'update_content'])
  assert.deepEqual(writes[1]!.body.update_content.content_updates, [{ old_str: '## Canary\n\nFive percent.', new_str: '## Canary\n\nTen percent.' }])
  assert.deepEqual(notionPages.get(TWO), { title: 'Shipping', markdown: 'How we ship.\n\n## Canary\n\nTen percent.\n\n## Rollback\n\nBy version ID.\n' })
  assert.equal(b.doc!.labels[SYNCED_LABEL], '12')
  // The retry guard: Notion says it already, so nothing is written, and it's recorded.
  requests.length = 0
  await provider.doc!({ target: 'notion:' + TWO + ':5', event: 'edited', doc: { id: '5', path: 'handbook/deploy', title: 'Shipping', revision: '12' }, body: '# Shipping\n\nHow we ship.\n\n## Canary\n\nTen percent.\n\n## Rollback\n\nBy version ID.\n' }, { key: 'notion', call: b.call })
  assert.deepEqual(requests.filter((request) => request.method === 'PATCH'), [])
})

test('a section added or removed replaces the content whole; a mirror is never written', async () => {
  notionPages.set(TWO, { title: 'Deploy', markdown: '## Canary\n\nFive percent.\n' })
  requests.length = 0
  await provider.doc!({ target: 'notion:' + TWO + ':5', event: 'edited', doc: { id: '5', path: 'handbook/deploy', title: 'Deploy', revision: '13' }, body: '# Deploy\n\n## Canary\n\nFive percent.\n\n## Rollback\n\nBy version ID.\n' }, { key: 'notion' })
  assert.deepEqual(requests.filter((request) => request.method === 'PATCH').map((request) => request.body.type), ['replace_content'])
  assert.equal(notionPages.get(TWO)!.markdown, '## Canary\n\nFive percent.\n\n## Rollback\n\nBy version ID.')
  requests.length = 0
  await provider.doc!({ target: 'notion:' + MIRROR + ':6', event: 'edited', doc: { id: '6', path: 'handbook/mirror', title: 'Handbook', revision: '3' }, body: '# Handbook\n\nchanged on the board\n' }, { key: 'notion' })
  assert.deepEqual(requests, [])
})

test("sectionUpdates: one per changed section of the content; null when its shape changed or an old text isn't once in it", () => {
  const page = 'Intro.\n\n## A\n\nSame.\n\n## B\n\nSame.\n'
  assert.deepEqual(sectionUpdates(page, page.replace('Intro.', 'Hello.')), [{ old_str: 'Intro.', new_str: 'Hello.' }])
  assert.deepEqual(sectionUpdates(page, page.replace('## B\n\nSame.', '## B\n\nOther.')), [{ old_str: '## B\n\nSame.', new_str: '## B\n\nOther.' }])
  assert.equal(sectionUpdates(page, page + '\n## C\n\nNew.\n'), null)
  assert.equal(sectionUpdates(page, page.replace('## B', '## Bee')), null)
  assert.equal(sectionUpdates('## A\n\nx\n', 'Now an intro.\n\n## A\n\nx\n'), null)
  assert.equal(sectionUpdates('## A\n\nx\n\n## A\n\nx\n', '## A\n\ny\n\n## A\n\nx\n'), null)
})

test('a page is its title as the first heading, then its content, and back', () => {
  assert.equal(docText('Deploy', '\n## A\n\nx\n\n'), '# Deploy\n\n## A\n\nx\n')
  assert.equal(docText('', ''), '# Untitled\n')
  assert.deepEqual(pageText('# Deploy\n\n## A\n\nx\n'), { title: 'Deploy', markdown: '## A\n\nx' })
})

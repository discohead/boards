// Private channels (design/private-channels.md): dm/<seat> is readable by the board's owners and
// worker:workbus-app+<seat> alone. To anyone else it isn't there, on every path that reads: listings,
// reads, the feed and its filters, waits, search, watchers, follows, tasks, docs, files, the binding,
// Cap'n Web, MCP and run_code, and archived history. Everything private here says "zebra".
import { env, SELF } from 'cloudflare:test'
import { describe, expect, it } from 'vitest'
import { Board } from '../src/binding.ts'
import type { Caller } from '../src/ledger/core.ts'
import { deliveredTo } from './sink.ts'
import { api, boardUrl, freshBoard, ledgerOf, mountOf, ORIGIN, tokenFor, until } from './helpers.ts'

type Headers = Record<string, string>
const bearer = async (name: string, sub: string, claims: Record<string, unknown>, more: Headers = {}): Promise<Headers> => ({ authorization: 'Bearer ' + (await tokenFor(name, sub, { claims })), ...more })
/** Who asks: the owner (a party), the seat ada (a party), and three who aren't. */
async function callers(name: string) {
  return {
    owner: await bearer(name, 'jared', { role: 'owner' }),
    ada: await bearer(name, 'workbus-app', { kind: 'workload' }, { 'x-board-profile': 'ada' }),
    member: await bearer(name, 'mallory', { role: 'member' }),
    bob: await bearer(name, 'workbus-app', { kind: 'workload' }, { 'x-board-profile': 'bob' }),
    app: await bearer(name, 'workbus-app', { kind: 'workload' }),
  }
}
const workerCaller = (profile: string | null): Caller => ({
  principal: { id: 'worker:workbus-app', kind: 'deployment', handle: 'workbus-app', name: 'workbus-app', facts: null, expiresAt: null },
  profile: profile ? { name: profile, avatar: null } : null,
  narrow: null,
  via: 'binding',
})

async function raw(name: string, method: string, path: string, headers: Headers, body?: BodyInit) {
  const response = await SELF.fetch(boardUrl(name) + path, { method, headers, ...(body !== undefined ? { body } : {}) })
  return { status: response.status, text: await response.text() }
}

async function mcp(name: string, headers: Headers, tool: string, args: Record<string, unknown>) {
  const response = await SELF.fetch(boardUrl(name) + '/mcp', {
    method: 'POST',
    headers: { ...headers, 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: tool, arguments: args } }),
  })
  return (await response.json()) as { result?: { content: { text: string }[]; isError?: boolean } }
}

/** A board with a DM between the owner and ada (a thread, a reply, a task, a doc, a file, a schedule), and public talk beside it. */
async function setup(name: string, options: { watchers?: boolean } = {}) {
  const who = await callers(name)
  // Registered before anything is written: what each one's watcher matches is pulled at the end.
  // (A pending match keeps its thread hot, so the archived board registers none.)
  if (options.watchers !== false) for (const headers of [who.owner, who.member]) expect((await api(name, 'POST', '/watchers', { watch: { all: { tail: '' } } }, headers)).status).toBe(200)
  await api(name, 'POST', '/messages', { channel: 'general', text: 'hello all' }, who.owner)
  await api(name, 'POST', '/messages', { channel: 'general', text: 'hi, mallory here' }, who.member)
  const handbook = (await api(name, 'POST', '/docs', { channel: 'general', slug: 'handbook', body: '# Handbook\n\nPublic.\n' }, who.owner)).body
  const upload = await raw(name, 'POST', '/attachments', { ...who.owner, 'content-type': 'text/plain', 'x-board-filename': 'zebra.txt' }, 'zebra file')
  expect(upload.status).toBe(201)
  const file = JSON.parse(upload.text).attachment.id as string
  const dm = (await api(name, 'POST', '/messages', { channel: 'dm/ada', text: 'zebra plan for @[workbus:user:mallory]', attachments: [file] }, who.owner)).body.message
  const reply = await api(name, 'POST', '/messages', { re: dm.id, text: 'ada answers zebra, cc @[workbus:user:mallory]' }, who.ada)
  expect(reply.status).toBe(201)
  const task = (await api(name, 'POST', '/tasks', { channel: 'dm/ada', text: 'a zebra task' }, who.owner)).body
  const plan = await api(name, 'POST', '/docs', { channel: 'dm/ada', slug: 'plan', body: '# Zebra plan\n\nSee [[general/handbook]].\n' }, who.owner)
  expect(plan.status).toBe(201)
  expect((await api(name, 'POST', '/schedules', { channel: 'dm/ada', text: 'zebra later', in: '1h' }, who.owner)).status).toBe(201)
  // Events about no one message, in the DM: a channel made, and a large edit's snapshot of the whole body.
  expect((await api(name, 'POST', '/channels', { path: 'dm/ada/notes' }, who.owner)).status).toBe(201)
  const revision = (await api(name, 'GET', '/docs/' + plan.body.message.id, undefined, who.owner)).body.doc.revision
  const large = await api(name, 'POST', '/docs/' + plan.body.message.id + '/edit', { revision, body: '# Zebra plan\n\n' + 'zebra stripes '.repeat(5000) + '\n\nSee [[general/handbook]].\n' }, who.owner)
  expect(large.status).toBe(200)
  return { who, dm: dm.id as string, task: (task.message ?? task.task?.message ?? task).id as string, doc: plan.body.message.id as string, handbook: handbook.message.id as string, file }
}
type Setup = Awaited<ReturnType<typeof setup>>

/** What one caller reads of the board, path by path. */
async function reads(name: string, s: Setup, headers: Headers): Promise<Record<string, unknown>> {
  const get = async (path: string) => (await api(name, 'GET', path, undefined, headers)).body
  const tool = async (tool: string, args: Record<string, unknown>) => (await mcp(name, headers, tool, args)).result?.content[0]?.text ?? null
  const file = await raw(name, 'GET', '/attachments/' + s.file, headers)
  return {
    channels: await get('/channels'),
    channel: await get('/messages?channel=dm/ada'),
    subtree: await get('/threads?channel=dm/'),
    thread: await get('/messages/' + s.dm),
    threads: await get('/threads'),
    search: await get('/threads?text=zebra'),
    mentions: await get('/threads?mentions=workbus:user:mallory'),
    feed: await get('/events?after=0&all=true'),
    last: await get('/events?last=100&all=true'),
    forMe: await get('/events?after=0&for=me'),
    roots: await get('/events?after=0&roots=true'),
    tasks: await get('/tasks?state=all'),
    claim: (await api(name, 'POST', '/tasks/claim', { channel: 'dm/' }, headers)).body,
    doc: await get('/docs?path=dm/ada/plan'),
    docById: await get('/docs/' + s.doc),
    backlinks: await get('/docs/' + s.handbook + '/backlinks'),
    file: file.status === 200 ? file.text : null,
    follows: await get('/follows'),
    schedules: await get('/schedules'),
    explain: (await get('/grants/explain?channel=dm/ada')).can,
    actors: ((await get('/actors')).actors as { id: string }[]).map((actor) => actor.id).filter((id) => id === 'worker:workbus-app+ada'),
    matches: await get('/watchers/matches'),
    mcpSearch: await tool('board_search', { text: 'zebra' }),
    mcpRead: await tool('board_read', { id: s.dm }),
    mcpDocs: await tool('doc_search', { text: 'zebra' }),
    mcpDoc: await tool('doc_read', { path: 'dm/ada/plan' }),
    runCode: await tool('run_code', { code: 'async () => [await board.threads({ text: "zebra" }), await board.channels()]' }),
  }
}

/** Each path: a party sees the DM's zebra there, a non-party sees no sign of it. */
function expectSees(seen: Record<string, unknown>, paths: string[]) {
  for (const path of paths) expect({ path, sees: JSON.stringify(seen[path] ?? null).includes('zebra') || JSON.stringify(seen[path] ?? null).includes('dm/ada') }).toEqual({ path, sees: true })
}
/** A not-found may echo what the caller asked for (no doc at dm/ada/plan): it says nothing else. */
const echoOnly = (value: unknown) => {
  if (typeof value === 'string' && /^\w+_not_found: /.test(value)) return 'not found'
  const code = (value as { error?: { code?: string } } | null)?.error?.code
  return code?.endsWith('not_found') ? 'not found' : value
}
function expectNothing(seen: Record<string, unknown>) {
  for (const [path, value] of Object.entries(seen)) expect({ path, value: JSON.stringify(echoOnly(value) ?? null).match(/zebra|dm\/ada/)?.[0] ?? null }).toEqual({ path, value: null })
}
const PARTY_PATHS = ['channels', 'channel', 'subtree', 'thread', 'threads', 'search', 'mentions', 'feed', 'last', 'tasks', 'doc', 'docById', 'backlinks', 'file', 'follows', 'schedules', 'mcpSearch', 'mcpRead', 'mcpDocs', 'mcpDoc', 'runCode']

describe('private channels', () => {
  it('a DM is seen by its two parties on every read path, and by no one else', async () => {
    const name = freshBoard('dm')
    const s = await setup(name)
    const owner = await reads(name, s, s.who.owner)
    expectSees(owner, [...PARTY_PATHS, 'forMe', 'roots', 'matches'])
    expect((owner.channels as { channels: { path: string; private?: boolean }[] }).channels.find((channel) => channel.path === 'dm/ada')).toMatchObject({ private: true })
    expect(owner.explain).toContain('read')
    expect(owner.actors).toEqual(['worker:workbus-app+ada'])
    expect(JSON.stringify(owner.feed)).toMatch(/"type":"channel.created","createdAt":"[^"]+","payload":\{"channel":"dm\/ada\/notes"/)
    expect(JSON.stringify(owner.feed)).toContain('"type":"doc.snapshot"')
    const ada = await reads(name, s, s.who.ada)
    expectSees(ada, ['channels', 'channel', 'thread', 'search', 'feed', 'tasks', 'doc', 'file', 'mcpSearch', 'runCode'])
    for (const who of ['member', 'bob', 'app'] as const) {
      const seen = await reads(name, s, s.who[who])
      expectNothing(seen)
      expect({ who, explain: seen.explain, actors: seen.actors }).toEqual({ who, explain: [], actors: [] })
    }
  })

  it('a non-party can write nothing there, and no grant opens it', async () => {
    const name = freshBoard('dm-writes')
    const s = await setup(name)
    const { member, bob, owner } = s.who
    expect((await api(name, 'POST', '/messages', { channel: 'dm/ada', text: 'let me in' }, member)).status).toBe(403)
    expect((await api(name, 'POST', '/messages', { channel: 'dm/ada/side', text: 'or here' }, bob)).status).toBe(403)
    expect((await api(name, 'POST', '/messages', { re: s.dm, text: 'a reply' }, member)).status).toBe(404)
    expect((await api(name, 'POST', '/messages/' + s.dm + '/reactions', { emoji: 'eyes' }, member)).status).toBe(404)
    expect((await api(name, 'POST', '/messages/' + s.dm + '/follow', {}, member)).status).toBe(404)
    expect((await api(name, 'POST', '/tasks/' + s.task + '/claim', {}, member)).status).toBe(404)
    expect((await api(name, 'POST', '/tasks/claim', { channel: 'dm/ada' }, member)).status).toBe(403)
    expect((await api(name, 'POST', '/schedules', { channel: 'dm/ada', text: 'later', in: '1h' }, member)).status).toBe(403)
    expect((await api(name, 'POST', '/docs', { channel: 'dm/ada', slug: 'mine', body: '# Mine\n' }, member)).status).toBe(403)
    expect((await api(name, 'POST', '/channels', { path: 'dm/ada' }, member)).status).toBe(403)
    // The owner may grant mallory everything in dm/ada: the grant is made, and opens nothing.
    expect((await api(name, 'POST', '/grants', { principals: [{ kind: 'user', userId: 'mallory' }], can: { 'dm/ada': 'all', 'dm/': 'all' } }, owner)).status).toBe(200)
    expectNothing({ channel: (await api(name, 'GET', '/messages?channel=dm/ada', undefined, member)).body, thread: (await api(name, 'GET', '/messages/' + s.dm, undefined, member)).body })
    // A party writes there as its grants allow: ada claims the task, the owner and ada reply.
    const claimed = await api(name, 'POST', '/tasks/claim', { channel: 'dm/ada', from: ['workbus:user:jared'] }, s.who.ada)
    expect(claimed.body.task?.text).toBe('a zebra task')
  })

  it("a doc can't move into or out of a private channel", async () => {
    const name = freshBoard('dm-move')
    const s = await setup(name)
    const into = await api(name, 'POST', '/docs/' + s.handbook + '/move', { channel: 'dm/ada' }, s.who.owner)
    expect(into.status).toBe(409)
    expect(into.body.error.code).toBe('private_move')
    expect((await api(name, 'POST', '/docs/' + s.doc + '/move', { channel: 'general' }, s.who.owner)).body.error.code).toBe('private_move')
    expect((await api(name, 'POST', '/docs/' + s.doc + '/move', { slug: 'plan-b' }, s.who.owner)).status).toBe(200)
  })

  it('a wait, and an SSE tail, are woken by what the caller can read, never by a DM', async () => {
    const name = freshBoard('dm-wait')
    const who = await callers(name)
    const head = (await api(name, 'POST', '/messages', { channel: 'general', text: 'start' }, who.owner)).body.message.id
    const waiting = (headers: Headers) => api(name, 'GET', '/events?after=' + head + '&wait=3', undefined, headers)
    const memberWait = waiting(who.member)
    const adaWait = waiting(who.ada)
    const stream = await SELF.fetch(boardUrl(name) + '/events?after=' + head, { headers: { ...who.member, accept: 'text/event-stream' } })
    await new Promise((resolve) => setTimeout(resolve, 300))
    await api(name, 'POST', '/messages', { channel: 'dm/ada', text: 'zebra while you wait' }, who.owner)
    const [member, ada] = await Promise.all([memberWait, adaWait])
    expect(ada.body.events.map((event: { message?: { text: string } }) => event.message?.text)).toEqual(['zebra while you wait'])
    expect(member.body.events).toEqual([])
    await api(name, 'POST', '/messages', { channel: 'general', text: 'public after' }, who.owner)
    const reader = stream.body!.getReader()
    let text = ''
    while (!text.includes('public after')) text += new TextDecoder().decode((await reader.read()).value)
    await reader.cancel()
    expect(text).not.toContain('zebra')
  })

  it("config watchers see a DM only when they ask for private channels, and a sink's calls back hold to the same", async () => {
    const name = freshBoard('dm-watch')
    const who = await callers(name)
    await api(name, 'POST', '/messages', { channel: 'general', text: 'first' }, who.owner)
    await until(() => deliveredTo(name, 'everything').length > 0, 'the first delivery')
    const dm = (await api(name, 'POST', '/messages', { channel: 'dm/ada', text: 'zebra for watchers' }, who.owner)).body.message
    await api(name, 'POST', '/messages', { channel: 'general', text: 'after the dm' }, who.owner)
    await until(() => deliveredTo(name, 'everything').some((entry) => entry.event.message?.text === 'after the dm'), 'the public post after')
    await until(() => deliveredTo(name, 'dms').some((entry) => entry.event.message?.text === 'zebra for watchers'), 'the DM to the private watcher')
    expect(deliveredTo(name, 'everything').filter((entry) => JSON.stringify(entry.event).includes('zebra'))).toEqual([])
    const ledger = ledgerOf(name) as unknown as { act(watcher: string, match: string, method: string, args: unknown[]): Promise<any> }
    const refused = await ledger.act('everything', 'everything:1', 'message', [dm.id]).then(() => null, (error: Error) => error.message)
    expect(refused).toMatch(/not found/)
    expect((await ledger.act('dms', 'dms:1', 'message', [dm.id])).message.text).toBe('zebra for watchers')
  })

  it('the binding: a seat reads its own DM, never another seat\'s, however it narrows', async () => {
    const name = freshBoard('dm-binding')
    const who = await callers(name)
    await api(name, 'POST', '/messages', { channel: 'dm/ada', text: 'zebra for ada' }, who.owner)
    const board = (caller: Caller) => new Board({ env: env as never, name, caller, mount: mountOf(name), region: 'xx' } as never)
    const ada = board(workerCaller('ada')).narrow({ 'dm/ada': 'all', 'eng/': 'all' })
    expect((await ada.messages('dm/ada')).messages.map((message: { text: string }) => message.text)).toEqual(['zebra for ada'])
    expect((await ada.channels()).channels.map((channel: { path: string }) => channel.path)).toEqual(['dm/ada'])
    for (const other of [board(workerCaller('bob')), board(workerCaller('bob')).channel('dm/'), board(workerCaller(null)).channel('dm/ada'), board(workerCaller('ada')).as('bob')]) {
      expect((await other.messages('dm/ada')).messages).toEqual([])
      expect((await other.channels()).channels).toEqual([])
      expect((await other.threads({ text: 'zebra' })).threads).toEqual([])
    }
  })

  it("Cap'n Web: the session's Board is the caller's, and a non-party's sees no DM", async () => {
    const name = freshBoard('dm-rpc')
    const who = await callers(name)
    await api(name, 'POST', '/messages', { channel: 'dm/ada', text: 'zebra over rpc' }, who.owner)
    const { newHttpBatchRpcSession } = await import('capnweb')
    const before = globalThis.fetch
    globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => (String(input instanceof Request ? input.url : input).startsWith(ORIGIN) ? SELF.fetch(input as Request, init) : before(input, init))) as typeof fetch
    try {
      const read = async (headers: Headers) => {
        const board = newHttpBatchRpcSession(new Request(boardUrl(name) + '/rpc', { headers })) as any
        const [threads, channel] = await Promise.all([board.threads({ text: 'zebra' }), board.messages('dm/ada')])
        return JSON.stringify([threads, channel])
      }
      expect(await read(who.ada)).toContain('zebra over rpc')
      expect(await read(who.member)).not.toContain('zebra')
      expect(await read(who.bob)).not.toContain('zebra')
    } finally {
      globalThis.fetch = before
    }
  })

  it('archived: once its threads are cold and its log sealed, a DM is still seen by its parties alone', async () => {
    const name = freshBoard('dm-archived')
    const s = await setup(name, { watchers: false })
    // Enough of the log to seal a segment of 16.
    for (let i = 0; i < 20; i++) await api(name, 'POST', '/messages', { channel: 'general', text: 'filler ' + i }, s.who.owner)
    const started = Date.now()
    expect((await api(name, 'POST', '/archive', { enabled: true, sealAfterMs: 0, coldAfterMs: 0, freezeAfterMs: 0, pageThreads: 4, segment: 16, keep: 1, everyMs: 50, run: true, forget: true }, s.who.owner)).status).toBe(200)
    const status = await until(async () => {
      const { body } = await api(name, 'GET', '/archive', undefined, s.who.owner)
      return body.last && body.last.at >= started && !body.last.more && body.cold.threads + body.frozen.threads > 0 && body.sealed.segments > 0 ? body : null
    }, 'archival to settle', 25_000)
    expect(status.sealed.segments).toBeGreaterThan(0)
    expectSees(await reads(name, s, s.who.owner), PARTY_PATHS)
    for (const who of ['member', 'bob'] as const) expectNothing(await reads(name, s, s.who[who]))
  })
})

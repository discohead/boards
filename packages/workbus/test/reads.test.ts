// Read state (design/read-state.md): what's unread for an actor is what reached it since it last
// read, and it didn't write. Each test reads the counts through GET /unread, as the app does at load.
import { SELF } from 'cloudflare:test'
import { describe, expect, it } from 'vitest'
import { api, boardUrl, freshBoard, headOf, rows, tokenFor } from './helpers.ts'

const as = async (name: string, sub: string, method: string, path: string, body?: unknown, headers: Record<string, string> = {}) =>
  api(name, method, path, body, { authorization: 'Bearer ' + (await tokenFor(name, sub)), ...headers })
const post = async (name: string, sub: string, body: Record<string, unknown>) => {
  const made = await as(name, sub, 'POST', '/messages', body)
  expect(made.status, JSON.stringify(made.body)).toBe(201)
  return made.body.message.id as string
}
type Counts = { unread: number; mentions: number; read: string | null }
const unread = async (name: string, sub: string, query = '', headers: Record<string, string> = {}) => {
  const answer = await as(name, sub, 'GET', '/unread' + query, undefined, headers)
  expect(answer.status, JSON.stringify(answer.body)).toBe(200)
  const channels = new Map<string, Counts>((answer.body.channels as (Counts & { channel: string })[]).map((entry) => [entry.channel, entry]))
  const threads = new Map<string, Counts & { channel: string }>((answer.body.threads as (Counts & { thread: string; channel: string })[]).map((entry) => [entry.thread, entry]))
  return { channels, threads, cursor: answer.body.cursor as string }
}
const channel = async (name: string, sub: string, path: string) => (await unread(name, sub)).channels.get(path) ?? { unread: 0, mentions: 0 }
const thread = async (name: string, sub: string, id: string) => (await unread(name, sub)).threads.get(id) ?? { unread: 0, mentions: 0 }
const mark = async (name: string, sub: string, body: Record<string, unknown>) => {
  const answer = await as(name, sub, 'POST', '/read', body)
  expect(answer.status, JSON.stringify(answer.body)).toBe(200)
  return answer.body
}
/** Everyone writes once, so a mention of them settles. */
const meet = async (name: string, ...subs: string[]) => {
  for (const sub of subs) await post(name, sub, { channel: 'hello', text: 'hi from ' + sub })
}

describe('read state', () => {
  it("a channel counts the threads others start after your cursor, never your own or replies", async () => {
    const name = freshBoard('reads-channel')
    await meet(name, 'jared', 'ada')
    const first = await post(name, 'ada', { channel: 'general', text: 'one' })
    await post(name, 'ada', { channel: 'general', text: 'two' })
    await post(name, 'jared', { channel: 'general', text: 'mine' })
    await post(name, 'ada', { re: first, text: 'a reply' })
    expect(await channel(name, 'jared', 'general')).toMatchObject({ unread: 2, mentions: 0, read: null })
    expect(await channel(name, 'ada', 'general')).toMatchObject({ unread: 1 })
    const marked = await mark(name, 'jared', { channel: 'general' })
    expect(marked).toMatchObject({ channel: 'general', unread: 0, mentions: 0 })
    expect((await unread(name, 'jared')).channels.has('general')).toBe(false)
    await post(name, 'ada', { channel: 'general', text: 'three' })
    expect(await channel(name, 'jared', 'general')).toMatchObject({ unread: 1, read: marked.read })
    // A channel named is listed even when nothing in it is unread.
    await mark(name, 'jared', { channel: 'general' })
    expect((await unread(name, 'jared', '?channel=general')).channels.get('general')).toMatchObject({ unread: 0, mentions: 0 })
  })

  it('a thread counts the replies that reach you: in threads you follow, by others', async () => {
    const name = freshBoard('reads-thread')
    await meet(name, 'jared', 'ada', 'bob')
    const mine = await post(name, 'jared', { channel: 'general', text: 'Lunch?' })
    const adas = await post(name, 'ada', { channel: 'general', text: 'Status?' })
    await post(name, 'ada', { re: mine, text: 'Sure.' })
    await post(name, 'bob', { re: mine, text: 'Me too.' })
    await post(name, 'jared', { re: mine, text: 'Noon.' })
    await post(name, 'bob', { re: adas, text: 'Green.' })
    const counts = await unread(name, 'jared')
    expect(counts.threads.get(mine)).toMatchObject({ unread: 2, mentions: 0, channel: 'general' })
    // Jared follows nothing in ada's thread: its reply reached him not.
    expect(counts.threads.has(adas)).toBe(false)
    expect((await thread(name, 'ada', mine)).unread).toBe(2)
    await mark(name, 'jared', { thread: mine })
    expect((await unread(name, 'jared')).threads.has(mine)).toBe(false)
    await post(name, 'ada', { re: mine, text: 'Make it 12:30.' })
    expect(await thread(name, 'jared', mine)).toMatchObject({ unread: 1 })
  })

  it('a mention counts on the channel for a root, and on the thread and its channel for a reply', async () => {
    const name = freshBoard('reads-mentions')
    await meet(name, 'jared', 'ada')
    await mark(name, 'jared', { channel: 'hello' })
    const root = await post(name, 'ada', { channel: 'ops', text: '@jared can you look?' })
    expect(await channel(name, 'jared', 'ops')).toMatchObject({ unread: 1, mentions: 1 })
    await mark(name, 'jared', { channel: 'ops' })
    const other = await post(name, 'ada', { channel: 'ops', text: 'Another thing.' })
    await mark(name, 'jared', { channel: 'ops' })
    await post(name, 'ada', { re: other, text: 'And @jared, this.' })
    const counts = await unread(name, 'jared')
    expect(counts.threads.get(other)).toMatchObject({ unread: 1, mentions: 1 })
    expect(counts.channels.get('ops')).toMatchObject({ unread: 0, mentions: 1 })
    expect(counts.threads.has(root)).toBe(false)
  })

  it('on a doc, a comment counts in the discussions you follow, not in others', async () => {
    const name = freshBoard('reads-doc')
    await meet(name, 'jared', 'ada', 'bob')
    const made = await as(name, 'bob', 'POST', '/docs', { channel: 'docs', slug: 'roadmap', body: '# Roadmap\n\n## Q3\n\nTBD.\n' })
    const doc = made.body.message.id as string
    const calling = await post(name, 'ada', { re: doc, text: '@jared what do you think?' })
    await post(name, 'bob', { re: calling, text: 'I think Q3.' })
    await post(name, 'bob', { re: doc, text: 'A new topic.' })
    expect(await thread(name, 'jared', doc)).toMatchObject({ unread: 2, mentions: 1 })
    // Bob made the doc: every comment on it reaches him.
    expect(await thread(name, 'bob', doc)).toMatchObject({ unread: 1 })
  })

  it('a deleted message stops counting, whether or not you had read past it', async () => {
    const name = freshBoard('reads-delete')
    await meet(name, 'jared', 'ada')
    const read = await post(name, 'ada', { channel: 'general', text: 'read one' })
    await mark(name, 'jared', { channel: 'general' })
    const unseen = await post(name, 'ada', { channel: 'general', text: '@jared unread one' })
    await post(name, 'ada', { channel: 'general', text: 'unread two' })
    expect(await channel(name, 'jared', 'general')).toMatchObject({ unread: 2, mentions: 1 })
    expect((await as(name, 'ada', 'POST', '/messages/' + unseen + '/delete', {})).status).toBe(200)
    expect(await channel(name, 'jared', 'general')).toMatchObject({ unread: 1, mentions: 0 })
    expect((await as(name, 'ada', 'POST', '/messages/' + read + '/delete', {})).status).toBe(200)
    expect(await channel(name, 'jared', 'general')).toMatchObject({ unread: 1, mentions: 0 })
    // Someone who never read the channel: its live roots by others.
    expect((await channel(name, 'bob', 'general')).unread).toBe(1)
    const mine = await post(name, 'jared', { channel: 'general', text: 'mine' })
    const reply = await post(name, 'ada', { re: mine, text: '@jared a reply' })
    await post(name, 'ada', { re: mine, text: 'another' })
    expect(await thread(name, 'jared', mine)).toMatchObject({ unread: 2, mentions: 1 })
    expect((await as(name, 'ada', 'POST', '/messages/' + reply + '/delete', {})).status).toBe(200)
    expect(await thread(name, 'jared', mine)).toMatchObject({ unread: 1, mentions: 0 })
  })

  it('marks read up to a point, and back again', async () => {
    const name = freshBoard('reads-upto')
    await meet(name, 'jared', 'ada')
    const ids: string[] = []
    for (const text of ['one', '@jared two', 'three', 'four']) ids.push(await post(name, 'ada', { channel: 'general', text }))
    await post(name, 'jared', { channel: 'general', text: 'mine' })
    expect(await mark(name, 'jared', { channel: 'general', upto: ids[1] })).toMatchObject({ unread: 2, mentions: 0, read: ids[1] })
    expect(await channel(name, 'jared', 'general')).toMatchObject({ unread: 2, mentions: 0, read: ids[1] })
    expect(await mark(name, 'jared', { channel: 'general', upto: ids[0] })).toMatchObject({ unread: 3, mentions: 1 })
    expect(await channel(name, 'jared', 'general')).toMatchObject({ unread: 3, mentions: 1 })
    await mark(name, 'jared', { channel: 'general' })
    expect(await mark(name, 'jared', { channel: 'general', upto: '0' })).toMatchObject({ unread: 4, mentions: 1 })
    const root = await post(name, 'jared', { channel: 'work', text: 'a thread' })
    const replies: string[] = []
    for (const text of ['r1', '@jared r2', 'r3']) replies.push(await post(name, 'ada', { re: root, text }))
    await post(name, 'jared', { re: root, text: 'mine' })
    expect(await mark(name, 'jared', { thread: replies[0], upto: replies[0] })).toMatchObject({ thread: root, unread: 2, mentions: 1 })
    expect(await thread(name, 'jared', root)).toMatchObject({ unread: 2, mentions: 1, read: replies[0] })
    expect(await mark(name, 'jared', { thread: root, upto: replies[1] })).toMatchObject({ unread: 1, mentions: 0 })
    // On a doc, only the comments that reached you count, after any point.
    const made = await as(name, 'ada', 'POST', '/docs', { channel: 'docs', slug: 'plan', body: '# Plan\n' })
    const doc = made.body.message.id as string
    const calling = await post(name, 'ada', { re: doc, text: '@jared a question' })
    await post(name, 'ada', { re: doc, text: 'another topic' })
    await post(name, 'ada', { re: calling, text: 'an answer' })
    expect(await thread(name, 'jared', doc)).toMatchObject({ unread: 2, mentions: 1 })
    expect(await mark(name, 'jared', { thread: doc, upto: doc })).toMatchObject({ unread: 2, mentions: 1 })
  })

  it('marking read writes nothing to the log', async () => {
    const name = freshBoard('reads-no-log')
    await meet(name, 'jared', 'ada')
    const root = await post(name, 'ada', { channel: 'general', text: 'one' })
    await post(name, 'ada', { re: root, text: 'two' })
    const head = await headOf(name)
    await mark(name, 'jared', { channel: 'general' })
    await mark(name, 'jared', { thread: root, upto: root })
    expect(await headOf(name)).toBe(head)
  })

  it('a moved doc takes its count to its new channel', async () => {
    const name = freshBoard('reads-move')
    await meet(name, 'jared', 'ada')
    const made = await as(name, 'ada', 'POST', '/docs', { channel: 'drafts', slug: 'plan', body: '# Plan\n\nFor @jared.\n' })
    const doc = made.body.message.id as string
    await post(name, 'ada', { channel: 'docs', text: 'a note' })
    expect(await channel(name, 'jared', 'drafts')).toMatchObject({ unread: 1, mentions: 1 })
    await mark(name, 'jared', { channel: 'docs' })
    expect((await as(name, 'ada', 'POST', '/docs/' + doc + '/move', { channel: 'docs' })).status).toBe(200)
    expect(await channel(name, 'jared', 'drafts')).toMatchObject({ unread: 0, mentions: 0 })
    // Older than jared's cursor in docs: read there.
    expect(await channel(name, 'jared', 'docs')).toMatchObject({ unread: 0, mentions: 0 })
    expect(await channel(name, 'bob', 'docs')).toMatchObject({ unread: 2 })
    expect(await channel(name, 'ada', 'docs')).toMatchObject({ unread: 0 })
    expect((await as(name, 'ada', 'POST', '/docs/' + doc + '/move', { channel: 'drafts' })).status).toBe(200)
    expect(await channel(name, 'jared', 'drafts')).toMatchObject({ unread: 1, mentions: 1 })
  })

  it('unfollowing a thread marks it read', async () => {
    const name = freshBoard('reads-unfollow')
    await meet(name, 'jared', 'ada')
    const mine = await post(name, 'jared', { channel: 'general', text: 'mine' })
    await post(name, 'ada', { re: mine, text: 'a reply' })
    expect((await thread(name, 'jared', mine)).unread).toBe(1)
    expect((await as(name, 'jared', 'POST', '/messages/' + mine + '/follow', { on: false })).status).toBe(200)
    await post(name, 'ada', { re: mine, text: 'another' })
    expect((await unread(name, 'jared')).threads.has(mine)).toBe(false)
  })

  it("counts never show a channel the caller can't read", async () => {
    const name = freshBoard('reads-private')
    await meet(name, 'jared', 'ada')
    const secret = await post(name, 'ada', { channel: 'secret', text: '@jared hush' })
    await post(name, 'ada', { re: secret, text: 'more @jared' })
    const narrowed = { 'x-board-can': 'hello=read' }
    const counts = await unread(name, 'jared', '', narrowed)
    expect([...counts.channels.keys()]).toEqual(['hello'])
    expect(counts.threads.size).toBe(0)
    expect((await unread(name, 'jared', '?channel=secret', narrowed)).channels.size).toBe(0)
    for (const body of [{ channel: 'secret' }, { thread: secret }, { channel: 'nowhere' }]) {
      const refused = await as(name, 'jared', 'POST', '/read', body, narrowed)
      expect(refused.status, JSON.stringify(body)).toBe(404)
    }
    expect((await unread(name, 'jared')).channels.get('secret')).toMatchObject({ unread: 1, mentions: 2 })
  })

  it('refuses a mark that names nothing, or two things', async () => {
    const name = freshBoard('reads-bad')
    for (const body of [{}, { channel: 'a', thread: '1' }, { channel: 'a', upto: 'x' }]) {
      const refused = await api(name, 'POST', '/read', body)
      expect(refused.status, JSON.stringify(body)).toBe(400)
    }
    expect((await api(name, 'GET', '/unread?channel=Bad Path')).status).toBe(400)
  })

  it('over MCP: board_unread and board_mark_read, as the caller', async () => {
    const name = freshBoard('reads-mcp')
    await meet(name, 'jared', 'ada')
    await post(name, 'ada', { channel: 'general', text: '@jared over MCP' })
    const call = async (method: string, params: Record<string, unknown>) => {
      const response = await SELF.fetch(boardUrl(name) + '/mcp', {
        method: 'POST',
        headers: { authorization: 'Bearer ' + (await tokenFor(name, 'jared')), 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
      })
      return ((await response.json()) as { result: any }).result
    }
    const listed = (await call('tools/list', {})).tools as { name: string; description: string }[]
    expect(listed.map((entry) => entry.name)).toEqual(expect.arrayContaining(['board_unread', 'board_mark_read']))
    expect(listed.find((entry) => entry.name === 'run_code')!.description).toMatch(/unread\(query\?[\s\S]*markRead\(input/)
    const before = JSON.parse((await call('tools/call', { name: 'board_unread', arguments: { channel: 'general' } })).content[0].text)
    expect(before.channels).toEqual([{ channel: 'general', unread: 1, mentions: 1, read: null }])
    const marked = await call('tools/call', { name: 'board_mark_read', arguments: { channel: 'general' } })
    expect(marked.isError, marked.content[0].text).toBeUndefined()
    expect(await channel(name, 'jared', 'general')).toMatchObject({ unread: 0, mentions: 0 })
  })

  it('a private channel writes no read state for anyone who is not its party, mentioned or not', async () => {
    const name = freshBoard('reads-dm')
    const owner = { authorization: 'Bearer ' + (await tokenFor(name, 'jared', { claims: { role: 'owner' } })) }
    const member = { authorization: 'Bearer ' + (await tokenFor(name, 'mallory', { claims: { role: 'member' } })) }
    const ada = { authorization: 'Bearer ' + (await tokenFor(name, 'workbus-app', { claims: { kind: 'workload' } })), 'x-board-profile': 'ada' }
    expect((await api(name, 'POST', '/messages', { channel: 'general', text: 'mallory is here' }, member)).status).toBe(201)
    const dm = (await api(name, 'POST', '/messages', { channel: 'dm/ada', text: 'a plan for @[workbus:user:mallory]' }, owner)).body.message.id as string
    expect((await api(name, 'POST', '/messages', { re: dm, text: 'cc @[workbus:user:mallory]' }, ada)).status).toBe(201)
    expect((await api(name, 'POST', '/messages', { re: dm, text: 'and the owner again' }, owner)).status).toBe(201)
    const held = async (actor: string) => [
      ...(await rows(name, "select channel from read_channels where actor = ? and channel like 'dm/%'", actor)),
      ...(await rows(name, "select channel from read_threads where actor = ? and channel like 'dm/%'", actor)),
    ]
    expect(await held('workbus:user:mallory')).toEqual([])
    expect((await held('workbus:user:jared')).length).toBe(2)
    expect((await held('worker:workbus-app+ada')).length).toBe(2)
    expect((await api(name, 'GET', '/unread', undefined, member)).body.channels.map((entry: { channel: string }) => entry.channel)).toEqual([])
    expect((await api(name, 'GET', '/unread', undefined, owner)).body.threads).toEqual([expect.objectContaining({ thread: dm, unread: 1 })])
  })

  it('keeps counts in side tables, a row per reader', async () => {
    const name = freshBoard('reads-rows')
    await meet(name, 'jared', 'ada', 'bob')
    const root = await post(name, 'jared', { channel: 'general', text: 'a thread' })
    await post(name, 'ada', { re: root, text: 'a reply' })
    expect(await rows(name, 'select actor, unread from read_threads where root = ? order by actor', Number(root))).toEqual([{ actor: 'workbus:user:jared', unread: 1 }])
  })
})

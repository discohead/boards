// Behavior fixed after the docs' review: each test fails without its fix.
import { env } from 'cloudflare:test'
import { describe, expect, it } from 'vitest'
import { WatcherBoard } from '../src/mailbox.ts'
import { api, freshBoard, ORIGIN, boardUrl } from './helpers.ts'
import { SELF } from 'cloudflare:test'

const root = async (name: string, channel = 'general', text = 'a root') => {
  const posted = await api(name, 'POST', '/messages', { channel, text })
  expect(posted.status).toBe(201)
  return posted.body.message.id as string
}
const repliesOf = async (name: string, id: string) => (await api(name, 'GET', '/messages/' + id)).body.replies as { id: string; text: string; by: { actor: string } }[]

describe('a watcher', () => {
  it("replays its writes when its delivery is retried, so a retry doesn't post twice", async () => {
    const name = freshBoard('watch-retry')
    const id = await root(name)
    // Two attempts at one delivery: each gets its own WatcherBoard, as the Mailbox gives each try.
    await new WatcherBoard(env as never, name, 'everything', 'match-1').reply(id, 'on it')
    await new WatcherBoard(env as never, name, 'everything', 'match-1').reply(id, 'on it')
    expect((await repliesOf(name, id)).map((reply) => reply.text)).toEqual(['on it'])
  })

  it('still makes each of several writes in one attempt', async () => {
    const name = freshBoard('watch-two')
    const id = await root(name)
    const board = new WatcherBoard(env as never, name, 'everything', 'match-2')
    await board.reply(id, 'first')
    await board.reply(id, 'second')
    expect((await repliesOf(name, id)).map((reply) => reply.text)).toEqual(['first', 'second'])
  })

  it('is told what is wrong with a bad call, as the HTTP route would say it', async () => {
    const name = freshBoard('watch-bad')
    await root(name)
    const board = new WatcherBoard(env as never, name, 'everything', 'match-3')
    const refusal = (work: Promise<unknown>) => work.then(() => 'allowed', (error: Error) => error.message)
    expect(await refusal(board.reply(undefined as never, 'x'))).toMatch(/reply takes a message ID/)
    expect(await refusal(board.post('general', { text: 'x'.repeat(10_001) }))).toMatch(/text/)
  })
})

describe('discovery', () => {
  it('is enough for a binding to find a board no one has used yet', async () => {
    const name = freshBoard('mount')
    const before = await Promise.resolve(new WatcherBoard(env as never, name, 'w', 'm').me()).then(() => 'ok', (error: Error) => error.message)
    expect(before).toMatch(/no_mount|served/)
    const discovered = await SELF.fetch(boardUrl(name) + '/')
    expect(discovered.status).toBe(200)
    const after = await new WatcherBoard(env as never, name, 'w', 'm').me()
    expect((after as { actor: string }).actor).toBe('workbus:watch:w')
  })
})

describe('openapi.json', () => {
  it('lists every method of a path that has several', async () => {
    const response = await SELF.fetch(boardUrl(freshBoard('openapi')) + '/openapi.json')
    const { paths } = (await response.json()) as { paths: Record<string, Record<string, { operationId: string }>> }
    expect(Object.keys(paths['/messages']!).sort()).toEqual(['get', 'post'])
    expect(paths['/tasks']!.get!.operationId).toBe('tasks')
    expect(paths['/tasks']!.post!.operationId).toBe('createTask')
  })
})

describe('avatars', () => {
  it('serves a mark for a name, with no token, and 404s a name it cannot be', async () => {
    const name = freshBoard('avatar')
    const ok = await SELF.fetch(boardUrl(name) + '/avatars/claude')
    expect(ok.status).toBe(200)
    expect(ok.headers.get('content-type')).toBe('image/svg+xml')
    expect(await ok.text()).toContain('>C</text>')
    expect((await SELF.fetch(boardUrl(name) + '/avatars/Not%20one')).status).toBe(404)
  })
})

describe('links', () => {
  it("finds the board thread and message a platform link names, from sync's records", async () => {
    const name = freshBoard('links')
    expect((await api(name, 'POST', '/watchers', { watch: {}, sync: [{ key: 'gh', platform: 'github' }] })).status).toBe(200)
    const author = { id: 'gh:user:1', handle: 'octo', name: 'octo', avatar: null, isBot: false }
    const imported = await api(name, 'POST', '/sync/imports', { op: 'post', from: 'gh', author, origin: { channel: 'gh:acme/web', thread: 'gh:acme/web:12', subthread: null, message: 'issue', context: null }, channel: 'web', text: 'Issue #12', id: 'i-12' })
    expect(imported.status).toBe(200)
    const rootId = imported.body.message as string
    const comment = await api(name, 'POST', '/sync/imports', { op: 'post', from: 'gh', author, origin: { channel: 'gh:acme/web', thread: 'gh:acme/web:12', subthread: null, message: 'comment-99', context: null }, re: rootId, text: 'a comment', id: 'c-99' })
    const commentId = comment.body.message as string

    const thread = await api(name, 'GET', '/links?url=' + encodeURIComponent('https://github.com/acme/web/issues/12'))
    expect(thread.status).toBe(200)
    expect(thread.body.message.id).toBe(rootId)
    const reply = await api(name, 'GET', '/links?url=' + encodeURIComponent('https://github.com/acme/web/issues/12#issuecomment-99'))
    expect(reply.status).toBe(200)
    expect(reply.body.replies.map((message: { id: string }) => message.id)).toContain(commentId)
    expect((await api(name, 'GET', '/links?url=' + encodeURIComponent('https://github.com/acme/web/issues/13'))).status).toBe(404)
    expect((await api(name, 'GET', '/links?url=' + encodeURIComponent('https://example.com/acme/web/issues/12'))).status).toBe(404)
  })
})

describe('sync imports', () => {
  it("refuses one that writes as someone the board signs in, before the board has seen them", async () => {
    const name = freshBoard('impersonate')
    // A sync key that reads like the board's own people: its users' IDs would start workbus:.
    expect((await api(name, 'POST', '/watchers', { watch: {}, sync: [{ key: 'workbus', platform: 'github' }] })).status).toBe(200)
    const author = { id: 'workbus:user:ada', handle: 'ada', name: 'Ada', avatar: null, isBot: false }
    const forged = await api(name, 'POST', '/sync/imports', { op: 'post', from: 'workbus', author, channel: 'web', text: 'as Ada', id: 'f-1' })
    expect(forged.status).toBe(403)
    expect(forged.body.error.message).toBe('workbus:user:ada is someone this board signs in, not a platform user: sync can' + "'" + 't write as them')
  })
})

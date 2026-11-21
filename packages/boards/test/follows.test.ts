// Follows (design/follows.md): an event reaches someone when it mentions them or is in something
// they follow, and they didn't write it. Each test reads what reaches a person through the feed's
// for filter, as a tail or a watcher would.
import { describe, expect, it } from 'vitest'
import { parseWatcherTail } from '../src/ledger/watchers.ts'
import { api, freshBoard, tokenFor, until } from './helpers.ts'
import { deliveredTo } from './sink.ts'

const as = async (name: string, sub: string, method: string, path: string, body?: unknown) => api(name, method, path, body, { authorization: 'Bearer ' + (await tokenFor(name, sub)) })
const post = async (name: string, sub: string, body: Record<string, unknown>) => {
  const made = await as(name, sub, 'POST', '/messages', body)
  expect(made.status, JSON.stringify(made.body)).toBe(201)
  return made.body.message.id as string
}
const doc = async (name: string, sub: string, slug: string) => {
  const made = await as(name, sub, 'POST', '/docs', { channel: 'docs', slug, body: '# ' + slug + '\n\n## Plan\n\nTBD.\n' })
  expect(made.status, JSON.stringify(made.body)).toBe(201)
  return made.body.message as { id: string; doc: { revision: string } }
}
/** The messages posted that reach sub: the feed's for filter, as sub sees it. */
const reaching = async (name: string, sub: string, query = '') => {
  const page = await as(name, sub, 'GET', '/events?after=0&for=me' + query)
  expect(page.status, JSON.stringify(page.body)).toBe(200)
  return (page.body.events as { type: string; message?: { id: string } }[]).map((event) => event.type + ' #' + event.message?.id)
}
/** Everyone writes once, so a mention of them settles. */
const meet = async (name: string, ...subs: string[]) => {
  for (const sub of subs) await post(name, sub, { channel: 'general', text: 'hi from ' + sub })
}

describe('follows', () => {
  it("a comment on a doc you made reaches you, whoever writes it; your own doesn't", async () => {
    const name = freshBoard('follow-own-doc')
    await meet(name, 'jared', 'ada', 'bob')
    const mine = await doc(name, 'jared', 'deploy')
    const fromAda = await post(name, 'ada', { re: mine.id, text: 'Is TBD a plan?' })
    const fromBob = await post(name, 'bob', { re: mine.id, section: 'deploy/plan', text: 'On the plan section.' })
    const fromMe = await post(name, 'jared', { re: mine.id, text: 'Working on it.' })
    const got = await reaching(name, 'jared')
    expect(got).toContain('message.posted #' + fromAda)
    expect(got).toContain('message.posted #' + fromBob)
    expect(got).not.toContain('message.posted #' + fromMe)
  })

  it("a comment on someone else's doc doesn't reach you, unless it mentions you", async () => {
    const name = freshBoard('follow-others-doc')
    await meet(name, 'jared', 'ada', 'bob')
    const bobs = await doc(name, 'bob', 'roadmap')
    const quiet = await post(name, 'ada', { re: bobs.id, text: 'Looks good.' })
    const calling = await post(name, 'ada', { re: bobs.id, text: '@jared should see this.' })
    const got = await reaching(name, 'jared')
    expect(got).not.toContain('message.posted #' + quiet)
    expect(got).toContain('message.posted #' + calling)
  })

  it('the rest of a discussion you were mentioned in reaches you; other discussions on that doc do not', async () => {
    const name = freshBoard('follow-discussion')
    await meet(name, 'jared', 'ada', 'bob')
    const bobs = await doc(name, 'bob', 'roadmap')
    const calling = await post(name, 'ada', { re: bobs.id, text: '@jared what do you think?' })
    const answer = await post(name, 'bob', { re: calling, text: 'I think Q3.' })
    const deeper = await post(name, 'ada', { re: answer, text: 'Q3 works.' })
    const elsewhere = await post(name, 'bob', { re: bobs.id, text: 'A new topic.' })
    const got = await reaching(name, 'jared')
    expect(got).toEqual(expect.arrayContaining(['message.posted #' + calling, 'message.posted #' + answer, 'message.posted #' + deeper]))
    expect(got).not.toContain('message.posted #' + elsewhere)
  })

  it('commenting follows your discussion, and a reaction to your comment reaches you', async () => {
    const name = freshBoard('follow-commented')
    await meet(name, 'jared', 'ada', 'bob')
    const bobs = await doc(name, 'bob', 'roadmap')
    const mine = await post(name, 'jared', { re: bobs.id, text: 'What about Q4?' })
    const reply = await post(name, 'ada', { re: mine, text: 'Q4 is late.' })
    expect((await as(name, 'ada', 'POST', '/messages/' + mine + '/reactions', { emoji: 'eyes' })).status).toBeLessThan(300)
    const got = await reaching(name, 'jared')
    expect(got).toContain('message.posted #' + reply)
    expect(got).toContain('reaction.added #' + mine)
  })

  it('an edit that mentions you reaches you, though an edit follows nothing', async () => {
    const name = freshBoard('follow-edit-mention')
    await meet(name, 'jared', 'ada')
    const adas = await post(name, 'ada', { channel: 'general', text: 'Who owns this?' })
    expect((await as(name, 'ada', 'POST', '/messages/' + adas + '/edit', { text: 'Who owns this? @jared' })).status).toBe(200)
    expect(await reaching(name, 'jared')).toContain('message.edited #' + adas)
  })

  it("editing a doc doesn't follow it", async () => {
    const name = freshBoard('follow-edit')
    await meet(name, 'jared', 'ada', 'bob')
    const bobs = await doc(name, 'bob', 'roadmap')
    expect((await as(name, 'jared', 'POST', '/docs/' + bobs.id + '/edit', { revision: bobs.doc.revision, edits: [{ section: 'roadmap/plan', text: 'Ship it.' }] })).status).toBe(200)
    const later = await post(name, 'ada', { re: bobs.id, text: 'Nice edit.' })
    expect(await reaching(name, 'jared')).not.toContain('message.posted #' + later)
  })

  it('unfollowing stops what the follow brought; a mention still reaches you', async () => {
    const name = freshBoard('follow-unfollow')
    await meet(name, 'jared', 'ada')
    const mine = await doc(name, 'jared', 'deploy')
    const off = await as(name, 'jared', 'POST', '/messages/' + mine.id + '/follow', { on: false })
    expect(off.body).toMatchObject({ following: false, thread: mine.id, discussion: null })
    const quiet = await post(name, 'ada', { re: mine.id, text: 'A comment.' })
    const calling = await post(name, 'ada', { re: mine.id, text: '@jared a question.' })
    const got = await reaching(name, 'jared')
    expect(got).not.toContain('message.posted #' + quiet)
    expect(got).toContain('message.posted #' + calling)
    const follows = (await as(name, 'jared', 'GET', '/follows')).body.follows as { thread: string; discussion: string | null; cause: string }[]
    expect(follows).toContainEqual(expect.objectContaining({ thread: mine.id, discussion: calling, cause: 'mentioned' }))
    expect(follows.some((entry) => entry.thread === mine.id && entry.discussion === null)).toBe(false)
  })

  it('in a thread that is not a doc, replying follows the whole thread', async () => {
    const name = freshBoard('follow-thread')
    await meet(name, 'jared', 'ada', 'bob')
    const adas = await post(name, 'ada', { channel: 'general', text: 'Lunch?' })
    const before = await post(name, 'bob', { re: adas, text: 'Sure.' })
    await post(name, 'jared', { re: adas, text: 'Me too.' })
    const after = await post(name, 'bob', { re: adas, text: 'Noon then.' })
    const got = await reaching(name, 'jared')
    expect(got).not.toContain('message.posted #' + before)
    expect(got).toContain('message.posted #' + after)
  })

  it('following yourself brings in what you chose; roots narrows to new threads', async () => {
    const name = freshBoard('follow-explicit')
    await meet(name, 'jared', 'ada', 'bob')
    const adas = await post(name, 'ada', { channel: 'general', text: 'Status?' })
    const on = await as(name, 'jared', 'POST', '/messages/' + adas + '/follow')
    expect(on.body).toMatchObject({ following: true, thread: adas })
    const reply = await post(name, 'bob', { re: adas, text: 'Green.' })
    expect(await reaching(name, 'jared')).toContain('message.posted #' + reply)
    const roots = await as(name, 'jared', 'GET', '/events?after=0&roots=true&channel=general')
    const ids = (roots.body.events as { message?: { id: string; re: string | null } }[]).map((event) => event.message!)
    expect(ids.length).toBeGreaterThan(0)
    expect(ids.every((message) => message.re === null)).toBe(true)
  })

  it("a deployment's --for watcher delivers what reaches its actor, though the actor was new after it compiled", async () => {
    const name = freshBoard('follow-deployed')
    // The board's first events are jared's: the watcher compiles before ada is known.
    const jareds = await post(name, 'jared', { channel: 'general', text: 'Standup notes.' })
    await until(() => deliveredTo(name, 'everything').length > 0, 'the board dispatching')
    const adas = await post(name, 'ada', { channel: 'general', text: 'My question.' })
    const answer = await post(name, 'jared', { re: adas, text: 'My answer.' })
    const aside = await post(name, 'jared', { re: jareds, text: 'Unrelated.' })
    await until(() => deliveredTo(name, 'for-ada').some((entry) => entry.event.message?.id === answer), 'the answer, delivered to ada')
    await new Promise((resolve) => setTimeout(resolve, 500))
    const delivered = deliveredTo(name, 'for-ada').map((entry) => entry.event.message?.id)
    expect(delivered).not.toContain(adas)
    expect(delivered).not.toContain(aside)
  })

  it('a watcher takes --for @handle and --roots, and has no "me"', () => {
    expect(parseWatcherTail('docs/ --for @jared --roots')).toEqual({ channel: 'docs/', for: 'jared', roots: true })
    expect(() => parseWatcherTail('docs/ --for me')).toThrow(/no "me"/)
  })
})

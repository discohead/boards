// A real run of the data layer (src/data) against a bus: the first pages, the live feed, and each
// write's optimistic row, its settling on its echo, and its rollback on a refusal. Another person's
// writes come from wb, as a separate process.
//   WORKBUS_URL=http://127.0.0.1:8834/b/bus WORKBUS_TOKEN=<owner token> OTHER_TOKEN=<another token> node scripts/data-check.ts
import { execFileSync } from 'node:child_process'
import { liveDb, busOf, createRuntime, readFirstPages, BusRefusal, type Message } from '../src/data/index.ts'

const url = process.env.WORKBUS_URL!
const token = process.env.WORKBUS_TOKEN!
const wbPath = new URL('../../../packages/workbus/cli/workbus.mjs', import.meta.url).pathname
const wb = (...args: string[]) => execFileSync('node', [wbPath, ...args, '--json'], { env: { ...process.env, WORKBUS_URL: url, WORKBUS_TOKEN: process.env.OTHER_TOKEN ?? token }, encoding: 'utf8' })

let failures = 0
const check = (ok: boolean, what: string, detail: unknown = '') => {
  if (!ok) failures++
  console.log((ok ? 'ok   ' : 'FAIL ') + what + (detail === '' ? '' : '  ' + (typeof detail === 'string' ? detail : JSON.stringify(detail))))
}
/** Resolves when test() holds, checked after every change to collection (or at the timeout). */
const until = async (collection: { subscribeChanges: (fn: () => void) => { unsubscribe: () => void } }, test: () => boolean, ms = 8000) => {
  if (test()) return 0
  const started = Date.now()
  return new Promise<number>((resolve) => {
    const timer = setTimeout(() => (sub.unsubscribe(), resolve(-1)), ms)
    const sub = collection.subscribeChanges(() => {
      if (test()) clearTimeout(timer), sub.unsubscribe(), resolve(Date.now() - started)
    })
  })
}

// 0. The server's first pages: a deadline gives what's read by then, and leaves out the rest.
const slow = (async (input: RequestInfo | URL, init?: RequestInit) => {
  if (String(input).includes('/actors')) await new Promise((resolve) => setTimeout(resolve, 1500))
  return fetch(input, init)
}) as typeof fetch
const quick = await readFirstPages(createRuntime('server', { url, token, fetch: slow }), { deadlineMs: 800 })
const names = quick.state.collections.map((chunk) => chunk.collectionId)
check(quick.late && !names.includes('actors') && names.includes('threads'), 'first pages at a deadline: what was read, without the late one', names)
const full = await readFirstPages(createRuntime('server', { url, token }))
check(!full.late && full.state.collections.length === 8 && full.state.collections.every((chunk) => Number.isInteger((chunk.syncMeta as { cursor: number }).cursor)), 'first pages in time: all eight, each with its cursor', full.state.collections.map((chunk) => chunk.collectionId + '@' + (chunk.syncMeta as { cursor: number }).cursor))

const KEEP = 40
const bus = busOf(liveDb({ url, token, keep: KEEP }))
await bus.runtime.shared.get('me')
await Promise.all([bus.channels, bus.threads, bus.messages, bus.tasks, bus.docs, bus.actors, bus.follows, bus.bodies, bus.unread].map((collection) => collection.preload()))
const feed = bus.runtime.feed!
check(bus.runtime.me.actor === 'workbus:user:jared' && Array.isArray(bus.runtime.me.can?.['*']), 'who I am, with what I may do', bus.runtime.me.can)
check(bus.threads.status === 'ready', 'collections ready', { threads: bus.threads.size, messages: bus.messages.size, tasks: bus.tasks.size, docs: bus.docs.size, actors: bus.actors.size, follows: bus.follows.size, feedAt: feed.cursor })

// 1. Another person posts from wb: it shows up live, in messages and in threads.
const text1 = 'from wb ' + Date.now()
const sent = Date.now()
const posted = JSON.parse(wb('post', 'general', text1)) as { message: Message }
const seen = await until(bus.messages, () => bus.messages.get(posted.message.id)?.text === text1)
check(seen >= 0, 'a post from wb shows up live', { id: posted.message.id, ms: Date.now() - sent })
check(bus.threads.get(posted.message.id)?.replies === 0, 'and as a thread')
check(bus.actors.has(posted.message.by.actor), 'and its author as an actor', posted.message.by.actor)

// 2. A reply from wb: the thread's count and last move.
const reply = JSON.parse(wb('reply', posted.message.id, 'a reply from wb')) as { message: Message }
await until(bus.threads, () => bus.threads.get(posted.message.id)?.replies === 1)
check(bus.threads.get(posted.message.id)?.last?.id === reply.message.id, "a wb reply moves its thread's count and last", bus.threads.get(posted.message.id)?.replies)

// 3. An optimistic post: there at once, pending; settled on its echo, with the board's ID.
const text2 = 'optimistic ' + Date.now()
const tx = bus.actions.post({ channel: 'general', text: text2 })
const optimistic = [...bus.messages.values()].find((message) => message.text === text2)
check(Boolean(optimistic?.pending), 'a post shows at once, pending', optimistic?.id)
check(bus.threads.has(optimistic?.id ?? ''), 'and its thread')
const before = Date.now()
await tx.when('settled')
const settled = [...bus.messages.values()].filter((message) => message.text === text2)
check(settled.length === 1 && !settled[0]!.pending && /^\d+$/.test(settled[0]!.id), 'it settles as one row with the board ID', { id: settled[0]?.id, ms: Date.now() - before })
check(feed.cursor! >= settled[0]!.version && Date.now() - before < 5000, 'on its echo: the feed had reached its event, well before the fallback', { feed: feed.cursor, event: settled[0]?.version })
const way = bus.actions.settledBy.get(optimistic!.id)
check(way === (process.env.EXPECT_CLIENT_ID ? 'clientId' : 'cursor'), 'settled by ' + (process.env.EXPECT_CLIENT_ID ? 'its client ID' : 'the cursor (this board carries no client IDs)'), way)
check(!bus.messages.has(optimistic!.id) && bus.threads.has(settled[0]!.id) && !bus.threads.has(optimistic!.id), 'the pending row and thread are gone, the board one is there')

// 4. A refused write rolls back: a reply to a thread that isn't there.
const refused = bus.actions.post({ re: '999999', text: 'into nothing' })
check([...bus.messages.values()].some((message) => message.text === 'into nothing'), 'a refused reply shows at once too')
const outcome = await refused.when('settled').then(() => 'persisted', (error: unknown) => error)
check(outcome instanceof BusRefusal, 'the board refuses it', outcome instanceof BusRefusal ? outcome.message : String(outcome))
check(![...bus.messages.values()].some((message) => message.text === 'into nothing'), 'and it rolls back', refused.state)

// 5. An edit: at once, then settled on the edit's echo. Someone else's message refuses, and rolls back.
const mine = settled[0]!
const editTx = bus.actions.edit({ id: mine.id, text: text2 + ' (edited)' })
check(bus.messages.get(mine.id)?.text === text2 + ' (edited)', 'an edit shows at once')
await editTx.when('settled')
const edited = bus.messages.get(mine.id)!
check(edited.text === text2 + ' (edited)' && edited.editedAt !== null && edited.version > mine.version, 'and settles on its echo', { version: edited.version, feed: feed.cursor })
const theirs = bus.actions.edit({ id: posted.message.id, text: 'not mine to edit' })
check(bus.messages.get(posted.message.id)?.text === 'not mine to edit', "an edit of someone else's message shows at once")
const theirsOutcome = await theirs.when('settled').then(() => 'persisted', (error: unknown) => error)
check(theirsOutcome instanceof BusRefusal && bus.messages.get(posted.message.id)?.text === text1, 'is refused, and rolls back', theirsOutcome instanceof BusRefusal ? theirsOutcome.message : String(theirsOutcome))

// 6. Tasks: one made here (optimistic, settled), and a state change from wb, live.
const taskTx = bus.actions.createTask({ channel: 'work', text: 'a task from the app ' + Date.now() })
const pendingTask = [...bus.tasks.values()].find((task) => task.pending)
check(pendingTask?.task?.state === 'ready', 'a task shows at once', pendingTask?.id)
await taskTx.when('settled')
const task = [...bus.tasks.values()].find((row) => row.text === pendingTask!.text)!
check(!task.pending && /^\d+$/.test(task.id), 'and settles with the board ID', task.id)
wb('tasks', 'claim', task.id)
const claimed = await until(bus.tasks, () => bus.tasks.get(task.id)?.task?.state === 'claimed')
check(claimed >= 0, 'a claim from wb shows up live', bus.tasks.get(task.id)?.task?.claim)

// 7. Follows: settled on the write's own answer (they aren't in the feed).
const followTx = bus.actions.follow({ thread: posted.message.id, on: true })
check(bus.follows.has(posted.message.id), 'a follow shows at once')
await followTx.when('settled')
check(bus.follows.has(posted.message.id), 'and stays when the board says so')
await bus.actions.follow({ thread: posted.message.id, on: false }).when('settled')
check(!bus.follows.has(posted.message.id), 'an unfollow too')

// 8. Opening: a thread's replies, a doc's body, and the body kept live.
const opened = await bus.openThread(posted.message.id)
check(bus.messages.has(reply.message.id) && opened.replies.length === 1, "an opened thread's replies are in messages")
const made = await bus.actions.createDoc({ channel: 'docs', slug: 'check-' + Date.now(), body: '# Check\n\nThe first body.' })
await until(bus.docs, () => bus.docs.has(made.id))
check(bus.docs.get(made.id)?.title === 'Check' && !('text' in bus.docs.get(made.id)!), 'a doc is in docs, without its body', bus.docs.get(made.id)?.path)
check(!bus.bodies.has(made.id), 'its body is not loaded until it is opened')
await bus.openDoc(made.id)
check(bus.bodies.get(made.id)?.body === '# Check\n\nThe first body.', 'opening it loads the body')
const wbOwner = (...args: string[]) => execFileSync('node', [wbPath, ...args], { env: { ...process.env, WORKBUS_URL: url, WORKBUS_TOKEN: token }, encoding: 'utf8' })
wbOwner('doc', 'edit', made.id, '--body', '# Check\n\nThe second body, from wb.')
const live = await until(bus.bodies, () => bus.bodies.get(made.id)?.body.includes('second body') === true)
check(live >= 0, "an open doc's body follows a wb edit live", bus.bodies.get(made.id)?.revision)
// 9. Memory: past `keep`, the oldest messages of threads not open go; an open thread's stay, and opening reads them back.
bus.openThread(posted.message.id)
for (let i = 0; i < KEEP + 10; i++) await bus.runtime.client.post('/messages', { channel: 'flood', text: 'flood ' + i })
const last = await bus.runtime.client.post<{ message: Message }>('/messages', { channel: 'flood', text: 'the last flood' })
await feed.reached(last.message.version)
check(bus.messages.size <= KEEP * 1.1 + 1, 'messages stay bounded', { size: bus.messages.size, keep: KEEP })
check(bus.messages.has(posted.message.id) && bus.messages.has(reply.message.id), "an open thread's messages stay")
bus.closeThread(posted.message.id)
const firstFlood = [...bus.messages.values()].find((message) => message.text === 'flood 0')
check(!firstFlood, 'the oldest loose ones went')
for (let i = 0; i < 10; i++) await bus.runtime.client.post('/messages', { channel: 'flood', text: 'more flood ' + i })
const after = await bus.runtime.client.post<{ message: Message }>('/messages', { channel: 'flood', text: 'the very last flood' })
await feed.reached(after.message.version)
const gone = !bus.messages.has(reply.message.id)
await bus.openThread(posted.message.id)
check(gone && bus.messages.has(reply.message.id), 'a closed thread can go, and opening it reads it back', { wentFirst: gone })

{
// 10. Read state (src/data/unread.ts): another person's root counts in its channel, a mention once
// more, and marking read zeroes it here and on the board.
const room = 'reads-' + Date.now().toString(36)
await bus.actions.createChannel(room)
check(bus.channels.has(room), 'a new channel is in channels at once')
const channelRow = () => bus.unread.get('channel:' + room)
wb('post', room, 'a root by someone else')
check((await until(bus.unread, () => (channelRow()?.unread ?? 0) === 1)) >= 0, "another person's root counts in its channel", channelRow())
wb('post', room, 'hey @jared')
check((await until(bus.unread, () => (channelRow()?.unread ?? 0) === 2 && channelRow()?.mentions === 1)) >= 0, 'a mention counts once more', channelRow())
await bus.actions.markRead({ channel: room })
check(channelRow()?.unread === 0 && channelRow()?.mentions === 0, 'marking read zeroes it here')
const unreadNow = await bus.runtime.client.get<{ channels: { channel: string }[] }>('/unread')
check(!unreadNow.channels.some((row) => row.channel === room), 'and on the board', unreadNow.channels)
const ownRoot = await bus.runtime.client.post<{ message: Message }>('/messages', { channel: room, text: 'my own root' })
const threadRow = () => bus.unread.get('thread:' + ownRoot.message.id)
wb('post', '--re', ownRoot.message.id, 'a reply in my thread')
check((await until(bus.unread, () => threadRow()?.unread === 1)) >= 0, 'a reply in a thread I follow counts in its thread', threadRow())
await bus.actions.markRead({ thread: ownRoot.message.id })
check(threadRow()?.unread === 0, 'and marking the thread read zeroes it')

// 11. Thread writes (src/data/thread-actions.ts): react, delete, and write it up, each optimistic or settled on its echo.
const reactTx = bus.actions.react({ id: ownRoot.message.id, emoji: 'eyes' })
check((bus.messages.get(ownRoot.message.id)?.reactions as Record<string, string[]>)?.eyes?.includes(bus.runtime.me.actor) === true, 'a reaction shows at once')
await reactTx.when('settled')
check((bus.messages.get(ownRoot.message.id)?.reactions as Record<string, string[]>)?.eyes?.length === 1, 'and settles as the board has it', bus.messages.get(ownRoot.message.id)?.reactions)
await bus.actions.react({ id: ownRoot.message.id, emoji: 'eyes', remove: true }).when('settled')
check(!(bus.messages.get(ownRoot.message.id)?.reactions as Record<string, string[]>)?.eyes, 'taking it away too')
const refused = bus.actions.react({ id: ownRoot.message.id, emoji: 'Not An Emoji' })
const rolled = await refused.when('settled').then(() => false, (error) => error instanceof BusRefusal)
check(rolled && !(bus.messages.get(ownRoot.message.id)?.reactions as Record<string, string[]>)?.['Not An Emoji'], 'a refused reaction rolls back')
await bus.actions.writeUp({ re: ownRoot.message.id, slug: 'written-' + ownRoot.message.id })
check(bus.messages.get(ownRoot.message.id)?.doc?.path?.endsWith('written-' + ownRoot.message.id) === true, 'write it up: the root gains a body, in place', bus.messages.get(ownRoot.message.id)?.doc?.path)
const doomed = await bus.runtime.client.post<{ message: Message }>('/messages', { channel: room, text: 'doomed' })
await feed.reached(doomed.message.version)
const removeTx = bus.actions.remove({ id: doomed.message.id })
check(bus.messages.get(doomed.message.id)?.deleted === true && bus.threads.get(doomed.message.id)?.root.deleted === true, 'a delete shows at once, in the thread list too')
await removeTx.when('settled')
check(bus.messages.get(doomed.message.id)?.deleted === true, 'and settles')

// 12. Older pages: openChannel(path, { before }) reads the page before a channel's newest.
const long = 'pages-' + Date.now().toString(36)
for (let i = 0; i < 55; i++) await bus.runtime.client.post('/messages', { channel: long, text: 'page root ' + i })
const newest = await bus.openChannel(long)
check(newest.older !== null && !bus.threads.has([...bus.threads.values()].find((thread) => thread.root.text === 'page root 0')?.id ?? ''), 'a channel opens at its newest 50, with a page before', newest)
const before = await bus.openChannel(long, { before: newest.older! })
check(before.older === null && [...bus.threads.values()].some((thread) => thread.root.text === 'page root 0'), 'the page before has its first root, and nothing before it', before)
}

console.log(failures ? failures + ' failed' : 'all passed')
feed.close()
process.exit(failures ? 1 : 0)

// The clean-up helper (cleanup.mjs) on a real bus: what a check made goes, and nothing else.
// - a thread the check started goes whole, someone else's reply in it included (as that author);
// - a reply the check made in someone else's thread goes alone: the thread stays;
// - what carries the run id, or its request's label (org.request), goes, if it's new since the start;
// - a doc that was there before the check, carrying the run id, stays;
// - a post by someone the check holds no credential for is listed: it needs the owner's moderation (#26);
// - archiving (#15) and hiding (#16) say they need those, until the board has them.
//   WORKBUS_OWNER_TOKEN=<owner> WORKBUS_OTHER_TOKEN=<member> WORKBUS_THIRD_TOKEN=<another member> node scripts/check/cleanup-check.mjs <board url>
import { busClient, cleaner } from './cleanup.mjs'

const board = (process.argv[2] ?? 'http://127.0.0.1:8832/b/bus').replace(/\/+$/, '')
const owner = busClient(board, { authorization: 'Bearer ' + process.env.WORKBUS_OWNER_TOKEN })
const other = busClient(board, { authorization: 'Bearer ' + process.env.WORKBUS_OTHER_TOKEN })
const third = busClient(board, { authorization: 'Bearer ' + process.env.WORKBUS_THIRD_TOKEN })
let failures = 0
const check = (ok, what, detail = '') => {
  if (!ok) failures++
  console.log((ok ? 'ok   ' : 'FAIL ') + what + (detail === '' ? '' : '  ' + JSON.stringify(detail)))
}
const run = 'cc' + Date.now().toString(36)
const channel = 'checks/cleanup'
const alive = async (id) => {
  const read = await owner.get('/messages/' + id + '?limit=500')
  const one = read.message.id === id ? read.message : read.replies.find((reply) => reply.id === id)
  return Boolean(one && !one.deleted)
}

// Before the check starts: a doc carrying the run id, and someone else's thread.
const before = (await owner.post('/docs', { channel: 'checks/cleanup-docs', slug: 'before-' + run, body: '# Before ' + run + '\n\nThere before the check.\n' })).message.id
const theirs = (await other.post('/messages', { channel, text: 'Their thread, there before the check' })).message.id
await new Promise((resolve) => setTimeout(resolve, 1100))

const clean = cleaner({ owner, others: [other] })
clean.marker(run)
clean.channel(channel)
clean.profile((await owner.whoami()) + '+cleaner')
const note = (path, answer, options) => clean.note(path, answer, options)

// The check's own writes.
const root = note('/messages', await owner.post('/messages', { channel, text: 'The check asks something ' + run }), { request: true }).message.id
const answer = (await other.post('/messages', { re: root, text: 'someone answers in it' })).message.id
const mine = note('/messages', await owner.post('/messages', { re: theirs, text: 'the check replies in their thread' })).message.id
const stamped = (await other.post('/messages', { channel: 'checks/cleanup-elsewhere', text: 'made for the request, no run id', labels: { 'org.request': root } })).message.id
const byThird = (await third.post('/messages', { channel, text: 'made by someone the check holds no credential for ' + run })).message.id
const task = note('/tasks', await owner.post('/tasks', { channel, text: 'a task the check made' })).task.id

const result = await clean.finish()
check(!(await alive(root)) && !(await alive(answer)), "the check's thread goes whole, someone else's reply in it too", { root, answer })
check(!(await alive(mine)) && (await alive(theirs)), 'its reply in their thread goes alone: their thread stays', { mine, theirs })
check(!(await alive(stamped)), "what's stamped with its request goes, wherever it is", stamped)
check(!(await alive(task)), 'its task goes', task)
check(await alive(before), 'a doc that was there before the check stays, though it carries the run id', before)
const listed = (what) => result.left.find((item) => item.what.startsWith(what))
check((await alive(byThird)) === Boolean(listed('#' + byThird)), 'a post it can neither delete as its author nor moderate is listed, not hidden', listed('#' + byThird) ?? 'deleted (moderation is live)')
check(Boolean(listed('channel ' + channel)) || result.archived === 1, 'the channel is archived, or listed as needing #15', listed('channel ' + channel) ?? 'archived')
check(Boolean(listed('actor ')) || result.hidden === 1, 'the profile is hidden, or listed as needing #16', listed('actor ') ?? 'hidden')
console.log(failures ? failures + ' failed' : 'all passed')
process.exitCode = failures ? 1 : 0

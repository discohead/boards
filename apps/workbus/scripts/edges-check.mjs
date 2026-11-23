// Edges with their meaning (design/workbus.md §4.3, §4.5, §5.5) and #20, on a real bus and app:
// the operator wakes for state changes of the tasks it made, not for replies in them (owned); a
// seat's plain @mention of another seat wakes nothing, a consult does (op consults the advisor),
// and the principal's mention always does; a hold escalated to a seat wakes it; a reviews edge
// makes a review task that work after the reviewed task waits on; and the board tools that carry
// them (task_block, task_answer, board_consult) do what their edges say.
//   pnpm dev:bus & pnpm dev   (the org set up: node scripts/org-setup.ts <board url> <owner token>; booted)
//   TOKEN=<owner token> APP_TOKEN=<a workload token for workbus-app> node scripts/edges-check.mjs http://127.0.0.1:8831 http://127.0.0.1:8832 [owned,mentions,escalate,review,tools]
// None of these call a model: the seats they watch are paused first (their wakes queue, and nothing
// runs), and each check reads what queued. Live, see "live" at the bottom.
import { boardTools } from '../src/harness/board.ts'

const [app = 'http://127.0.0.1:8831', bus = 'http://127.0.0.1:8832', only = 'owned,mentions,escalate,review,tools'] = process.argv.slice(2)
const owner = { authorization: 'Bearer ' + process.env.TOKEN }
const as = (profile) => ({ authorization: 'Bearer ' + process.env.APP_TOKEN, 'x-board-profile': profile })
const pick = new Set(only.split(','))
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const run = Math.random().toString(36).slice(2, 7)

let failures = 0
const check = (ok, what, detail = '') => {
  if (!ok) failures++
  console.log((ok ? 'ok   ' : 'FAIL ') + what + (detail === '' ? '' : '  ' + JSON.stringify(detail)))
}
async function board(method, path, body, headers = owner) {
  const response = await fetch(bus + '/b/bus' + path, { method, headers: { ...headers, ...(body ? { 'content-type': 'application/json' } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) })
  const answer = await response.json()
  if (!response.ok) throw new Error(method + ' ' + path + ': ' + response.status + ' ' + JSON.stringify(answer))
  return answer
}
async function until(fn, ms) {
  const end = Date.now() + ms
  for (;;) {
    const value = await fn().catch(() => null)
    if (value || Date.now() > end) return value
    await sleep(3000)
  }
}
async function seat(body) {
  const response = await fetch(app + '/dev/seat', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
  const answer = await response.json()
  if (!response.ok) throw new Error('dev/seat ' + body.call + ': ' + (answer?.error ?? response.status))
  return answer
}
/** The wakes a seat queued for a thread (its root's ID), after things settle. */
async function queued(key, thread, ms = 2500) {
  await sleep(ms)
  return (await seat({ seat: key, call: 'status' })).wakes.filter((wake) => wake.thread === thread)
}
/** Pauses a seat by its doc, as the principal, and waits for its Seat to say so. */
async function pause(key) {
  const { doc, body } = await board('GET', '/docs?path=org/seats/' + key)
  const fence = /(```json#seat@[12]\n)([\s\S]*?)(\n```)/
  const data = JSON.parse(fence.exec(body)[2])
  if (data.state !== 'paused') {
    data.state = 'paused'
    await board('POST', '/docs/' + doc.id + '/edit', { revision: doc.revision, body: body.replace(fence, (_, open, _old, close) => open + JSON.stringify(data, null, 2) + close) })
  }
  for (let i = 0; i < 30 && (await seat({ seat: key, call: 'status' })).state !== 'paused'; i++) await sleep(500)
}
const OP = 'worker:workbus-app+op'
const ADA = 'worker:workbus-app+ada'
const ADVISOR = 'worker:workbus-app+advisor'

if (['owned', 'mentions', 'escalate'].some((part) => pick.has(part))) {
  await pause('op')
  await pause('advisor')
}

if (pick.has('owned')) {
  // A task op makes, for ada: a reply in it, ada's claim, a reply by ada, and its completion.
  const made = await board('POST', '/tasks', { channel: 'eng/queue', text: 'owned check ' + run, for: ADA }, as('op'))
  const id = made.task.id
  await board('POST', '/messages', { re: id, text: 'a reply in its thread' })
  const claimed = await board('POST', '/tasks/' + id + '/claim', {}, as('ada'))
  await board('POST', '/messages', { re: id, text: 'ada says how it goes' }, as('ada'))
  await board('POST', '/tasks/' + id + '/complete', { epoch: claimed.claim.epoch, token: claimed.claim.token, result: 'done' }, as('ada'))
  const wakes = await queued('op', id)
  check(wakes.length === 2, 'op wakes twice for its task, claimed and completed, and not for the two replies', wakes.map((wake) => wake.id))
}

if (pick.has('mentions')) {
  const fyi = (await board('POST', '/messages', { channel: 'eng', text: '@[' + ADVISOR + '] FYI: routed it as three tasks (' + run + ').' }, as('op'))).message.id
  check((await queued('advisor', fyi)).length === 0, "op's plain @advisor wakes nothing")
  const consult = (await board('POST', '/messages', { channel: 'eng', text: '@[' + ADVISOR + '] Should this be one task or two? (' + run + ')', labels: { 'org.consult': 'advisor' } }, as('op'))).message.id
  check((await queued('advisor', consult)).length === 1, "op's consult wakes the advisor")
  const other = (await board('POST', '/messages', { channel: 'eng', text: '@[' + ADVISOR + '] a consult label, but not from op (' + run + ')', labels: { 'org.consult': 'advisor' } }, as('ada'))).message.id
  check((await queued('advisor', other)).length === 0, "a consult from a seat that doesn't consult it wakes nothing")
  const mine = (await board('POST', '/messages', { channel: 'eng', text: '@[' + ADVISOR + '] the principal asks something (' + run + ')' })).message.id
  check((await queued('advisor', mine)).length === 1, "the principal's @advisor wakes it")
  // The advisor's answer to the consult wakes op; its plain reply doesn't.
  const before = (await queued('op', consult, 0)).length
  await board('POST', '/messages', { re: consult, text: '@[' + OP + '] just a note (' + run + ')' }, as('advisor'))
  const afterNote = (await queued('op', consult)).length
  await board('POST', '/messages', { re: consult, text: '@[' + OP + '] Two tasks. (' + run + ')', labels: { 'org.answer': 'op' } }, as('advisor'))
  const afterAnswer = (await queued('op', consult)).length
  check(afterNote === before && afterAnswer === before + 1, "the advisor's answer to the consult wakes op; a plain reply mentioning op doesn't", { before, afterNote, afterAnswer })
}

if (pick.has('escalate')) {
  // ada escalates a task, as her task_block does: the label, then the hold as the app. One she
  // made, so op's own wakes (owned, for the tasks it made) don't answer for this one.
  const theirs = (await board('POST', '/tasks', { channel: 'eng/queue', text: 'escalate check, ada\'s own ' + run, for: ADA }, as('ada'))).task.id
  await board('POST', '/messages/' + theirs + '/labels', { set: { 'org.escalated': 'op' } }, as('ada'))
  await board('POST', '/tasks/' + theirs + '/block', { reason: 'which file format?', kind: 'decision' }, { authorization: 'Bearer ' + process.env.APP_TOKEN })
  const theirWakes = await queued('op', theirs)
  check(theirWakes.length === 1, 'a hold escalated to op wakes it, on a task it didn\'t make', theirWakes.map((wake) => wake.id))
  // On a task op made, op answers it, as the task's maker.
  const made = await board('POST', '/tasks', { channel: 'eng/queue', text: 'escalate check ' + run, for: ADA }, as('op'))
  const id = made.task.id
  await board('POST', '/messages/' + id + '/labels', { set: { 'org.escalated': 'op' } }, as('ada'))
  check((await queued('op', id, 1500)).length === 0, 'the label alone wakes nothing')
  await board('POST', '/tasks/' + id + '/block', { reason: 'which file format?', kind: 'decision' }, { authorization: 'Bearer ' + process.env.APP_TOKEN })
  const answered = await board('POST', '/tasks/' + id + '/unblock', { decision: 'approved', note: 'use JSON' }, as('op'))
  const task = answered.task?.task ?? answered.task
  check(task?.state === 'ready' && task.answer?.decision === 'approved', 'op answers it, as the task\'s maker', task)
}

if (pick.has('review')) {
  // op reviews ada: an edge added to Engineering's doc, as the principal.
  const { doc, body } = await board('GET', '/docs?path=org/teams/eng')
  const fence = /(```json#team@1\n)([\s\S]*?)(\n```)/
  const data = JSON.parse(fence.exec(body)[2])
  if (!data.edges.some((edge) => edge.kind === 'reviews')) {
    data.edges.push({ from: 'op', kind: 'reviews', to: 'ada' })
    await board('POST', '/docs/' + doc.id + '/edit', { revision: doc.revision, body: body.replace(fence, (_, open, _old, close) => open + JSON.stringify(data, null, 2) + close) })
  }
  for (let i = 0; i < 30 && !(await seat({ seat: 'ada', call: 'status' })).runtime?.reviewers?.includes('op'); i++) await sleep(500)
  check((await seat({ seat: 'ada', call: 'status' })).runtime?.reviewers?.includes('op'), "ada's Seat has op as her reviewer")
  const first = (await board('POST', '/tasks', { channel: 'eng/queue', text: 'review check, first ' + run, for: ADA }, as('op'))).task.id
  const second = (await board('POST', '/tasks', { channel: 'eng/queue', text: 'review check, second ' + run, for: ADA, needs: [first] }, as('op'))).task.id
  // ada's task_complete asks her Seat for the reviews first, then completes.
  const reviewed = await seat({ seat: 'ada', call: 'review', args: [first] })
  const again = await seat({ seat: 'ada', call: 'review', args: [first] })
  check(reviewed.reviews.length === 1 && reviewed.waiting.includes(second) && again.reviews[0] === reviewed.reviews[0], 'a review task for op, once, and the work after it waits on it', { reviewed, again })
  const review = (await board('GET', '/messages/' + reviewed.reviews[0])).message
  check(review.task.for === OP && review.text.includes('#' + first), 'the review is for op, naming the task', { for: review.task.for, text: review.text.slice(0, 80) })
  const claimed = await board('POST', '/tasks/' + first + '/claim', {}, as('ada'))
  await board('POST', '/tasks/' + first + '/complete', { epoch: claimed.claim.epoch, token: claimed.claim.token, result: 'done' }, as('ada'))
  const waits = (await board('GET', '/messages/' + second)).message.task
  check(waits.state === 'waiting' && waits.needs.includes(reviewed.reviews[0]), 'the first done, the second still waits for the review', waits)
  const claimReview = await board('POST', '/tasks/' + reviewed.reviews[0] + '/claim', {}, as('op'))
  await board('POST', '/tasks/' + reviewed.reviews[0] + '/complete', { epoch: claimReview.claim.epoch, token: claimReview.claim.token, result: 'looks right' }, as('op'))
  check((await board('GET', '/messages/' + second)).message.task.state === 'ready', 'the review done, the second is ready')
}

if (pick.has('tools')) {
  // The board tools as a Session builds them, over a board that records what it's asked.
  const asked = []
  const record = (name) => async (...args) => (asked.push([name, ...args]), { ok: true })
  const fake = (labels = {}) => ({
    read: async (id) => ({ message: { id, channel: id === '42' ? 'dm/op' : 'eng', labels, by: { actor: OP }, task: { owner: 'worker:workbus-app' } }, replies: [] }),
    post: record('post'),
    reply: record('reply'),
    label: record('label'),
    tasks: { block: record('block'), approve: record('approve'), decline: record('decline'), claim: async () => { throw new Error('not claimed') } },
  })
  const toolsOf = (seatRef, labels, more = {}) => Object.fromEntries(boardTools(() => fake(labels), { claimToken: () => 't', seat: () => seatRef, ...more }).map((tool) => [tool.name, tool]))
  const ctx = { callId: 'c', thread: '41', signal: new AbortController().signal }
  const ada = { key: 'ada', escalates: { key: 'op', actor: OP } }
  const escalated = []
  await toolsOf(ada, {}, { escalate: async (...args) => (escalated.push(args), {}) }).task_block.run({ id: '7', reason: 'which?', kind: 'decision' }, ctx)
  check(asked.some(([name, id, change]) => name === 'label' && id === '7' && change.set['org.escalated'] === 'op') && escalated.length === 1 && !asked.some(([name]) => name === 'block'), "ada's task_block labels the task for op and holds it through her Seat, not by her claim")
  asked.length = 0
  await toolsOf({ key: 'op' }, {}).task_block.run({ id: '8', reason: 'which?', kind: 'decision' }, ctx)
  check(asked.some(([name]) => name === 'block') && !asked.some(([name]) => name === 'label'), 'a seat escalating to the principal holds it as before, unlabeled')
  asked.length = 0
  const refused = await toolsOf({ key: 'op' }, { 'org.escalated': 'someone-else' }).task_answer.run({ id: '9', decision: 'approved', note: 'go' }, ctx)
  const allowed = await toolsOf({ key: 'op' }, { 'org.escalated': 'op' }).task_answer.run({ id: '9', decision: 'declined', note: 'not that way' }, ctx)
  check(refused.isError && !allowed.isError && asked.length === 1 && asked[0][0] === 'decline', 'task_answer answers only a task escalated to it', refused.text)
  asked.length = 0
  const op = { key: 'op', consults: [{ key: 'advisor', handle: 'advisor', actor: ADVISOR }] }
  const consulted = await toolsOf(op, {}).board_consult.run({ to: '@advisor', question: 'one task or two?' }, ctx)
  const nobody = await toolsOf({ key: 'ada' }, {}).board_consult.run({ to: 'advisor', question: 'hi?' }, ctx)
  check(!consulted.isError && asked[0][0] === 'reply' && asked[0][1] === '41' && asked[0][2].labels['org.consult'] === 'advisor' && asked[0][2].text.startsWith('@[' + ADVISOR + ']') && nobody.isError, 'board_consult asks in the thread, mentioning and labeled; a seat with no consults edge is refused', asked[0])
  asked.length = 0
  await toolsOf(op, {}).board_consult.run({ to: 'advisor', question: 'one task or two?', re: '42' }, ctx)
  check(asked[0]?.[0] === 'post' && asked[0][1] === 'ops/consults', "from a DM, which the advisor can't read, the consult starts a thread in ops/consults", asked[0])
  asked.length = 0
  const advisor = { key: 'advisor', consultedBy: [{ key: 'op', handle: 'op', actor: OP }] }
  const answered = await toolsOf(advisor, {}).board_answer.run({ id: '43', answer: 'two' }, ctx)
  const stranger = await toolsOf({ key: 'advisor' }, {}).board_answer.run({ id: '43', answer: 'two' }, ctx)
  check(!answered.isError && asked[0][0] === 'reply' && asked[0][2].labels['org.answer'] === 'op' && stranger.isError, 'board_answer answers a consult from a seat that consults it, labeled for it', asked[0])
}

// -- with the model (Haiku): run only when named. --------------------------------------------------
// "consult": the principal asks op something that needs a consult; op consults the advisor (in
// ops/consults: its DM is op's alone), the advisor answers once, op makes the tasks, and nothing
// more comes from the advisor. "replies": then a reply in one of those tasks, once it's done,
// doesn't wake op, and its completion did.
if (pick.has('consult')) {
  const started = new Date().toISOString()
  const asked = (await board('POST', '/messages', { channel: 'dm/op', text: 'Before you make any tasks, consult the advisor (board_consult): should "write hello-' + run + '.txt containing hello" be one task for Ada or two? When it answers, make what it suggests in eng/queue for Ada (no running code), and tell me here.' })).message.id
  const since = (m) => m.createdAt >= started
  const consultsOf = async () => (await board('GET', '/threads?channel=ops/consults&limit=20')).threads.map((t) => t.message).filter((m) => since(m) && m.by?.actor === OP && m.labels?.['org.consult'] === 'advisor')
  const consult = await until(async () => (await consultsOf())[0], 180_000)
  check(Boolean(consult), 'op consults the advisor, in ops/consults, labeled', consult && { id: consult.id, text: consult.text.slice(0, 120) })
  const answerOf = async () => consult && (await board('GET', '/messages/' + consult.id)).replies.filter((m) => m.by?.actor === ADVISOR)
  const answers = consult ? await until(async () => ((await answerOf()).length ? await answerOf() : null), 180_000) : null
  check(answers?.length === 1 && answers[0].labels?.['org.answer'] === 'op', 'the advisor answers it once, labeled for op', answers?.map((m) => m.text.slice(0, 120)))
  const made = await until(async () => {
    const tasks = (await board('GET', '/tasks?channel=eng/queue&state=all&limit=100')).tasks.map((t) => t.message).filter((m) => since(m) && m.by?.actor === OP)
    return tasks.length ? tasks : null
  }, 240_000)
  check(Boolean(made), 'op wakes on the answer and makes the tasks', made?.map((m) => m.text.slice(0, 80)))
  // Quiet: op's updates (its reply to the principal, the tasks it made) get nothing more from the advisor.
  await sleep(90_000)
  const fromAdvisor = (await board('GET', '/threads?channel=ops/&limit=50')).threads.map((t) => t.message).filter((m) => since(m) && m.by?.actor === ADVISOR)
  const repliesNow = consult ? (await answerOf()).length : 0
  check(fromAdvisor.length === 0 && repliesNow === 1, 'and the advisor says nothing more', { threads: fromAdvisor.length, replies: repliesNow })
  console.log('     the principal asked in #' + asked)
}

if (pick.has('replies')) {
  // The newest task op made that's done: a reply in it wakes op no more.
  const done = (await board('GET', '/tasks?channel=eng/queue&state=completed&limit=200')).tasks.map((t) => t.message).filter((m) => m.by?.actor === OP).sort((a, b) => (a.createdAt < b.createdAt ? -1 : 1)).at(-1)
  if (!done) check(false, 'a completed task op made, to reply in')
  else {
    const before = await queued('op', done.id, 0)
    check(before.length >= 1, 'op woke for that task changing state', before.map((wake) => wake.id))
    await board('POST', '/messages', { re: done.id, text: 'a reply after it was done (' + run + ')' })
    const after = await queued('op', done.id, 5000)
    check(after.length === before.length, 'a reply in it wakes op no more', { before: before.length, after: after.length })
  }
}

if (failures) {
  console.log(failures + ' failed')
  process.exit(1)
}
console.log('all passed')

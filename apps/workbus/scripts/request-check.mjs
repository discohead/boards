// Request stamping (org.request): every message, task, doc, and proposal a seat makes carries the id
// of the principal's message that started the work. Parts:
// - unit (node, no servers): which request a wake-up belongs to (seats/request.ts), and the board
//   tools stamping what they write, with the Seat labeling as the app where a seat may not.
// - flow (Haiku, vite dev and the bus's wrangler dev, the org booted): the principal asks the
//   advisor for a plan; "hand it off"; the advisor hands it to op, op makes the tasks, ada does them.
//   Everything the seats made carries the one request: the principal's first message.
// - schedule (no model): the operator's own schedule (its brief) starts no request.
//   TOKEN=<owner token> node scripts/request-check.mjs [app] [bus] [unit,flow,schedule]
import { requestOf, REQUEST } from '../src/seats/request.ts'
import { boardTools } from '../src/harness/board.ts'
import { busClient, cleaner } from './check/cleanup.mjs'

const [app = 'http://127.0.0.1:8831', bus = 'http://127.0.0.1:8832', only = 'unit'] = process.argv.slice(2)
const pick = new Set(only.split(','))
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
let failures = 0
const check = (ok, what, detail = '') => {
  if (!ok) failures++
  console.log((ok ? 'ok   ' : 'FAIL ') + what + (detail === '' ? '' : '  ' + JSON.stringify(detail).slice(0, 500)))
}

if (pick.has('unit')) {
  const person = { kind: 'person', handle: 'jared' }
  const agent = { kind: 'agent', handle: 'op' }
  const posted = (message) => ({ cursor: '1', type: 'message.posted', message })
  check(JSON.stringify(requestOf(posted({ id: '10', re: null, author: person, labels: {} }), ['dm'])) === JSON.stringify({ id: '10', via: 'person', reply: false }), "a person's message starts a request: its id")
  check(requestOf(posted({ id: '11', re: '10', author: person, labels: {} }), ['dm'])?.reply === true, "a person's reply is marked a reply, so a session working for the thread's request keeps it")
  check(requestOf(posted({ id: '12', re: null, author: agent, labels: { [REQUEST]: '10' } }), ['assigned'])?.id === '10', 'a message that carries org.request hands it on (a task, a hand-off, a proposal, a consult)')
  check(requestOf({ cursor: '2', type: 'task.ready', message: { id: '13', re: null, author: agent, labels: { [REQUEST]: '10' } } }, ['owned'])?.via === 'label', "a task's own events hand on its request")
  check(requestOf(posted({ id: '14', re: null, author: agent, labels: {} }), ['mention']) === null, "a seat's message without one starts none")
  check(requestOf(posted({ id: '15', re: null, author: agent, labels: {}, schedule: 's1' }), ['schedules']) === null, "a seat's own schedule starts none")
  check(requestOf(posted({ id: '16', re: null, author: person, labels: {} }), ['schedules']) === null, 'nor anything a schedules rule alone woke it for')

  // The tools: what they write carries the request; where the seat may not label, its Seat does.
  const asked = []
  const stamped = []
  let refuseLabels = false
  const write = (name) => async (...args) => {
    const input = args.at(-1)
    const labels = typeof input === 'object' ? (input.labels ?? (Array.isArray(input) ? input[0]?.labels : undefined)) : undefined
    if (refuseLabels && labels && Object.keys(labels).length) throw new Error("forbidden: this token can't label in org")
    asked.push([name, ...args])
    return name === 'docs.create' && args[0].propose ? { proposal: { id: '99', channel: 'org/seats' } } : { message: { id: String(50 + asked.length), channel: 'x' }, task: { id: String(50 + asked.length), state: 'ready' } }
  }
  const fake = { post: write('post'), reply: write('reply'), label: async (id, change) => { if (refuseLabels) throw new Error("forbidden: can't label"); stamped.push(['label', id, change]) }, tasks: { create: write('tasks.create'), createMany: write('tasks.createMany') }, docs: { create: write('docs.create'), edit: async (id, input) => (asked.push(['docs.edit', id, input]), { proposal: { id: '98', channel: 'eng' } }) } }
  let request = '10'
  const tools = Object.fromEntries(boardTools(() => fake, { claimToken: () => 't', seat: () => ({ key: 'op' }), request: () => request, stamp: async (id, value) => stamped.push(['stamp', id, value]) }).map((tool) => [tool.name, tool]))
  const ctx = { callId: 'c', thread: '10', signal: new AbortController().signal }
  await tools.board_post.run({ channel: 'eng', text: 'hi' }, ctx)
  await tools.board_reply.run({ id: '10', text: 'hi' }, ctx)
  await tools.task_create.run({ channel: 'eng/queue', text: 'do it' }, ctx)
  await tools.task_create_many.run({ channel: 'eng/queue', tasks: [{ key: 'a', text: 'one' }, { key: 'b', text: 'two', needs: ['a'] }] }, ctx)
  await tools.doc_create.run({ channel: 'docs/plans', slug: 'p', body: '# P' }, ctx)
  const labelsOf = (entry) => { const input = entry.at(-1); return Array.isArray(input) ? input.map((t) => t.labels?.[REQUEST]) : [input.labels?.[REQUEST]] }
  check(asked.length === 5 && asked.every((entry) => labelsOf(entry).every((value) => value === '10')), 'post, reply, task_create, task_create_many (each task), and doc_create carry org.request', asked.map(labelsOf))
  asked.length = 0
  await tools.doc_create.run({ channel: 'org/seats', slug: 'dana', body: '# Dana', propose: true }, ctx)
  await tools.doc_edit.run({ id: '7', body: '# T', propose: true }, ctx)
  check(stamped.some(([how, id, change]) => how === 'label' && id === '99' && change.set[REQUEST] === '10') && stamped.some(([how, id]) => how === 'label' && id === '98'), "a proposal's task is labeled with it after it's made (a new doc's and an edit's)", stamped)
  asked.length = 0
  stamped.length = 0
  refuseLabels = true
  await tools.board_post.run({ channel: 'org', text: 'in org/' }, ctx)
  check(asked.length === 1 && stamped.length === 1 && stamped[0][0] === 'stamp' && stamped[0][2] === '10', 'where the seat may not label, the write goes without, and its Seat labels it as the app', { asked, stamped })
  refuseLabels = false
  asked.length = 0
  request = null
  await tools.board_post.run({ channel: 'ops/briefs', text: 'no request' }, ctx)
  check(asked.length === 1 && Object.keys(asked[0][2].labels ?? {}).length === 0, 'with no request, nothing is labeled', asked[0])
}

const owner = { authorization: 'Bearer ' + process.env.TOKEN, 'content-type': 'application/json' }
const clean = cleaner({ owner: busClient(bus + '/b/bus', owner) }).guard()
async function board(method, path, body) {
  const response = await fetch(bus + '/b/bus' + path, { method, headers: owner, ...(body ? { body: JSON.stringify(body) } : {}) })
  const answer = await response.json()
  if (!response.ok) throw new Error(method + ' ' + path + ': ' + response.status + ' ' + JSON.stringify(answer))
  return method === 'POST' ? clean.note(path, answer, { request: path === '/messages' }) : answer
}
async function until(fn, ms) {
  const end = Date.now() + ms
  for (;;) {
    const value = await fn().catch(() => null)
    if (value || Date.now() > end) return value
    await sleep(3000)
  }
}
/** Every message seats wrote since a time, in the channels a request's work touches, with replies. */
async function seatWrites(since) {
  const out = []
  for (const channel of ['dm/advisor', 'docs/plans', 'ops/plans', 'ops/consults', 'eng/queue', 'eng', 'dm/op', 'dm/ada', 'org/seats', 'org/teams']) {
    const threads = (await board('GET', '/threads?channel=' + channel + '&limit=100').catch(() => ({ threads: [] }))).threads
    for (const { message } of threads) {
      const thread = await board('GET', '/messages/' + message.id)
      for (const m of [thread.message, ...thread.replies]) if (m.createdAt >= since && /^worker:workbus-app\+/.test(m.by?.actor ?? '')) out.push({ id: m.id, channel: m.channel, by: m.by.actor, request: m.labels?.[REQUEST] ?? null, text: m.text.slice(0, 60) })
    }
  }
  return out
}

/** Waits for the seats to be idle: a fresh board's seats introduce themselves first, with no request. */
async function idle(keys, ms = 180_000) {
  return until(async () => {
    for (const key of keys) {
      const status = await (await fetch(app + '/dev/seat', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ seat: key, call: 'status' }) })).json()
      if ((status.queue?.queued ?? 0) + (status.queue?.running ?? 0) > 0) return null
    }
    return true
  }, ms)
}

if (pick.has('flow')) {
  await idle(['advisor', 'op', 'ada'])
  const since = new Date().toISOString()
  const run = Math.random().toString(36).slice(2, 7)
  const asked = (await board('POST', '/messages', { channel: 'dm/advisor', text: 'Plan one tiny engineering task for Ada: write hello-' + run + '.txt containing the word hello. No questions: write the plan doc now, briefly, with the slug hello-' + run + '.' })).message.id
  const plan = await until(async () => (await board('GET', '/threads?channel=docs/plans&limit=20')).threads.map((t) => t.message).find((m) => m.createdAt >= since), 180_000)
  check(Boolean(plan) && plan.labels?.[REQUEST] === asked, 'the advisor writes the plan, a doc that carries the request', plan && { path: plan.doc?.path, labels: plan.labels })
  await board('POST', '/messages', { re: asked, text: 'Looks good, hand it off.' })
  const done = await until(async () => {
    const tasks = (await board('GET', '/tasks?channel=eng/queue&state=all&limit=100')).tasks.map((t) => t.message).filter((m) => m.createdAt >= since && m.by?.actor === 'worker:workbus-app+op')
    return tasks.length && tasks.every((m) => ['completed', 'blocked'].includes(m.task.state)) ? tasks : null
  }, 420_000)
  check(Boolean(done), "op makes the tasks and ada does them (or holds them)", done?.map((m) => m.id + ':' + m.task.state))
  await sleep(20_000)
  const writes = await seatWrites(since)
  const seats = [...new Set(writes.map((w) => w.by.split('+')[1]))]
  const off = writes.filter((w) => w.request !== asked)
  console.log('     ' + writes.length + ' writes by ' + seats.join(', ') + ' for request #' + asked)
  check(writes.length >= 4 && seats.includes('advisor') && seats.includes('op'), 'the advisor and op (and ada) wrote along the way', seats)
  for (const w of writes) console.log('     #' + w.id + ' ' + w.channel + ' ' + w.by.split('+')[1] + ' ' + (w.request ?? '(none)') + '  ' + w.text.replace(/\n/g, ' '))
  check(off.length === 0, "every message, task, doc, and proposal they made carries org.request = the principal's message", off.map((w) => w.id))
}

if (pick.has('hold')) {
  // A Seat-made item: the approval task a session holds for the principal carries its operation's request.
  const session = async (thread, call, ...args) => (await fetch(app + '/dev/session', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ seat: 'ada', thread, call, args }) })).json()
  const thread = (await board('POST', '/messages', { channel: 'eng', text: 'hold check' })).message.id
  await session(thread, 'configure', { key: 'ada', name: 'Ada', handle: 'ada', team: 'eng', can: 'all', tools: ['board', 'computer'], prompt: { charter: 'Be brief.' }, approve: { exec: 'approval' }, revision: 'hold-' + thread })
  await session(thread, 'submit', { type: 'turn', parts: [{ type: 'text', text: 'Use exec once with command: export default () => 1. Then answer "done".' }] }, { operationId: 'hold-1', request: { id: 'req-' + thread, via: 'label', reply: false } })
  const held = await until(async () => (await session(thread, 'inspect')).approvals?.find((a) => a.state === 'held'), 120_000)
  const task = held && (await board('GET', '/messages/' + held.id)).message
  check(task?.labels?.[REQUEST] === 'req-' + thread, "the approval task it holds for the principal carries the operation's request", task?.labels)
  if (held) await session(thread, 'submit', { type: 'approval', approvalId: held.id, approved: false, reason: 'check only' }, { operationId: 'hold-2' })
}

if (pick.has('schedule')) {
  // The operator's own schedule: its brief, written as the operator from the watchdog's facts.
  const since = new Date().toISOString()
  const response = await fetch(app + '/dev/seat', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ seat: 'op', call: 'briefNow' }) })
  const brief = await response.json()
  const doc = (await board('GET', '/threads?channel=ops/briefs&limit=10')).threads.map((t) => t.message).find((m) => (m.editedAt ?? m.createdAt) >= since)
  check(Boolean(brief?.written) && doc && !doc.labels?.[REQUEST], 'the brief its schedule writes carries no request', { brief, labels: doc?.labels })
}

// What this run made goes again (scripts/check/cleanup.mjs), unless KEEP is set: it says what it
// couldn't. On a failure or Ctrl-C, clean.guard() runs it too.
await clean.finish()
if (failures) {
  console.log(failures + ' failed')
  process.exit(1)
}
console.log('all passed')

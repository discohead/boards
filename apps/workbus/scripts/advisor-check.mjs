// The advisor (design/workbus.md §5.9) on a real bus and app: the seed adds it, and its team, to a
// board seeded before it without touching a doc the principal edited; the reconciler gives it its
// wake (dm, mention) as the seat itself, narrowed, with its DM and docs/plans/; its board tools
// refuse a task for any seat but the operator; and (with "dm") a DM to @advisor gets a question or
// a plan doc in docs/plans/, "looks good, hand it off" makes one task for @op naming the doc, and
// the operator wakes and decomposes it into eng/queue.
//   pnpm dev:bus & pnpm dev   (the bus's org set up: node scripts/org-setup.ts <board url> <owner token>)
//   TOKEN=<owner token> node scripts/advisor-check.mjs http://127.0.0.1:8831 http://127.0.0.1:8832 [seed,assigns,dm]
// Only "dm" calls a model (Haiku): a few turns of the advisor's, and the operator's first.
// Live: ACCESS_TOKEN=<an Access token for workbus.dev> instead of TOKEN, and the live origins, with "seed,dm".
import { boardTools } from '../src/harness/board.ts'
import { busClient, cleaner } from './check/cleanup.mjs'

const [app = 'http://127.0.0.1:8831', bus = 'http://127.0.0.1:8832', only = 'seed,assigns'] = process.argv.slice(2)
const token = process.env.TOKEN
const access = process.env.ACCESS_TOKEN
const auth = access ? { 'cf-access-token': access } : { authorization: 'Bearer ' + token }
const live = Boolean(access)
const clean = cleaner({ owner: busClient(bus + '/b/bus', auth) }).guard()
const pick = new Set(only.split(','))
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const OP = 'worker:workbus-app+op'

let failures = 0
const check = (ok, what, detail = '') => {
  if (!ok) failures++
  console.log((ok ? 'ok   ' : 'FAIL ') + what + (detail === '' ? '' : '  ' + JSON.stringify(detail)))
}
async function board(method, path, body) {
  const response = await fetch(bus + '/b/bus' + path, { method, headers: { ...auth, ...(body ? { 'content-type': 'application/json' } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) })
  const answer = await response.json()
  if (!response.ok) throw new Error(method + ' ' + path + ': ' + response.status + ' ' + JSON.stringify(answer))
  return method === 'POST' ? clean.note(path, answer, { request: path === '/messages' }) : answer
}
async function seat(body) {
  const response = await fetch(app + '/dev/seat', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
  const answer = await response.json()
  if (!response.ok) throw new Error('dev/seat ' + body.call + ': ' + (answer?.error ?? response.status))
  return answer
}
async function status(key) {
  if (!live) return seat({ seat: key, call: 'status' })
  const response = await fetch(app + '/api/seats/' + key, { headers: auth })
  if (!response.ok) throw new Error('GET /api/seats/' + key + ': ' + response.status)
  return response.json()
}
async function until(fn, ms) {
  const end = Date.now() + ms
  for (;;) {
    const value = await fn().catch(() => null)
    if (value || Date.now() > end) return value
    await sleep(2000)
  }
}

if (pick.has('seed')) {
  if (!live) {
    const again = await seat({ call: 'boot' })
    check(again.seeded.length === 0 && ['org/seats/advisor', 'org/teams/core'].every((path) => again.found.includes(path)), 'a boot after the advisor is seeded seeds nothing and finds its docs', again.found)
    check(again.pass.plan.problems.length === 0, 'the org plans with no problems, Core\'s edges to the principal included', again.pass.plan.problems)
  }
  const wake = (await board('GET', '/wakes')).wakes.find((one) => one.key === 'seat.advisor')
  check(wake?.actor === 'worker:workbus-app+advisor' && wake.rules.dm === 'dm' && wake.rules.mention === 'mention' && Boolean(wake.rules.consulted), "the advisor's wake is the seat itself, for dm, mention, and op's consults", wake && { actor: wake.actor, rules: wake.rules })
  check(Boolean(wake?.can.includes('dm/advisor/=') && wake.can.includes('docs/plans/=read,post,react,label,edit') && !/eng\/=[a-z,]*post/.test(wake.can)), 'narrowed to its DM, docs/plans/, and read in eng/', wake?.can)
  const runtime = (await status('advisor')).runtime
  check(runtime?.role === 'advisor' && runtime.team === 'core' && JSON.stringify(runtime.tools) === '["board"]', 'its Seat: the advisor, in Core, board only', runtime && { role: runtime.role, team: runtime.team, tools: runtime.tools })
  const core = await board('GET', '/docs?path=org/teams/core')
  check(/"to": "principal"/.test(core.body) && /"kind": "consults"/.test(core.body), "Core's doc holds the edges, the principal's included")
}

if (pick.has('assigns')) {
  // The board tools as the Session builds them for the advisor, over a board that records what it's asked.
  const asked = []
  const fake = { tasks: { create: async (input) => (asked.push(input), { task: { id: '1' } }), createMany: async (channel, tasks) => (asked.push({ channel, tasks }), { tasks: [] }) } }
  const tools = Object.fromEntries(boardTools(() => fake, { claimToken: () => 'token', seat: () => ({ key: 'advisor', assigns: [OP] }) }).map((tool) => [tool.name, tool]))
  const ctx = { callId: 'c', signal: new AbortController().signal }
  const toAda = await tools.task_create.run({ channel: 'ops/plans', text: 'x', for: 'worker:workbus-app+ada' }, ctx)
  const toNobody = await tools.task_create.run({ channel: 'ops/plans', text: 'x' }, ctx)
  const many = await tools.task_create_many.run({ channel: 'eng/queue', tasks: [{ key: 'a', text: 'x', for: OP }, { key: 'b', text: 'y', for: 'worker:workbus-app+ada' }] }, ctx)
  check(toAda.isError && toNobody.isError && many.isError && asked.length === 0, 'a task for another seat, or for no one, is refused before the board is asked', [toAda.text])
  const toOp = await tools.task_create.run({ channel: 'ops/plans', text: 'x', for: OP }, ctx)
  check(!toOp.isError && asked.length === 1 && asked[0].for === OP, 'a task for the operator goes through')
  const free = Object.fromEntries(boardTools(() => fake, { claimToken: () => 'token' }).map((tool) => [tool.name, tool]))
  check(!(await free.task_create.run({ channel: 'eng/queue', text: 'x', for: 'worker:workbus-app+ada' }, ctx)).isError, 'a seat with no assigns may assign anyone')
}

if (pick.has('dm')) {
  const run = Math.random().toString(36).slice(2, 7)
  const started = Date.now()
  const asked = (await board('POST', '/messages', { channel: 'dm/advisor', text: 'Help me plan a small launch checklist (' + run + ').' })).message
  const byAdvisor = (m) => m.by?.actor === 'worker:workbus-app+advisor'
  const replies = async () => (await board('GET', '/messages/' + asked.id)).replies.filter(byAdvisor)
  const plans = async () => (await board('GET', '/threads?channel=docs/plans&limit=50')).threads.map((t) => t.message).filter((m) => m.doc && byAdvisor(m) && Date.parse(m.createdAt) >= started)
  const first = await until(async () => (await replies()).at(0), 120_000)
  check(Boolean(first), 'the advisor answers in its DM', first?.text)
  if (first) await converse()
  async function converse() {
    let plan = (await plans()).at(0)
    if (!plan) {
      // It asked a sharpening question: answer it, briefly.
      console.log('     its question: ' + first?.text.replace(/\n/g, ' ').slice(0, 200))
      await board('POST', '/messages', { re: asked.id, text: 'Keep it tiny: three items for a small internal launch. Write the plan now, no more questions.' })
      plan = await until(async () => (await plans()).at(0), 180_000)
    }
    check(Boolean(plan?.doc?.path?.startsWith('docs/plans/')), 'it writes the plan as a doc in docs/plans/', plan?.doc?.path)
    const handoffFrom = Date.now()
    await board('POST', '/messages', { re: asked.id, text: 'Looks good, hand it off.' })
    const handoff = await until(async () => {
      const tasks = (await board('GET', '/tasks?channel=ops/&state=all&limit=200')).tasks.map((t) => t.message)
      return tasks.find((m) => byAdvisor(m) && Date.parse(m.createdAt) >= handoffFrom)
    }, 180_000)
    check(handoff?.task?.for === OP && Boolean(plan && handoff.text.includes(plan.doc.path)), 'it hands the plan to @op: one task, for the operator, naming the doc', handoff && { for: handoff.task.for, text: handoff.text.slice(0, 200) })
    const decomposed = await until(async () => {
      const tasks = (await board('GET', '/tasks?channel=eng/queue&state=all&limit=200')).tasks.map((t) => t.message)
      const made = tasks.filter((m) => m.by?.actor === OP && Date.parse(m.createdAt) >= handoffFrom)
      return made.length > 0 ? made : null
    }, 240_000)
    check(Boolean(decomposed), 'the operator wakes and decomposes it into eng/queue', decomposed?.map((m) => m.text.slice(0, 80)))
    // It read the plan itself: a run since the hand-off with a doc_read that succeeded (its can reads docs/plans/).
    const reads = await until(async () => {
      const runs = (await status('op')).runs.filter((run) => Date.parse(run.ended) >= handoffFrom)
      const read = runs.flatMap((run) => run.tools).filter((tool) => tool.name === 'doc_read')
      return read.some((tool) => tool.ok) ? read : null
    }, 60_000)
    check(Boolean(reads), "the operator reads the plan's doc (a doc_read that succeeds)", reads ?? (await status('op')).runs.filter((run) => Date.parse(run.ended) >= handoffFrom).map((run) => run.tools))
    // Then the advisor stays quiet: the operator's update in the hand-off's thread (even one that mentions it) gets no answer.
    if (handoff) {
      await sleep(90_000)
      const thread = (await board('GET', '/messages/' + handoff.id)).replies
      const fromOp = thread.filter((m) => m.by?.actor === OP)
      const after = thread.filter((m) => byAdvisor(m) && fromOp.some((op) => Number(m.id) > Number(op.id)))
      console.log('     the operator in the thread: ' + fromOp.map((m) => (m.text.includes('@advisor') ? '[mentions @advisor] ' : '') + m.text.replace(/\n/g, ' ').slice(0, 120)).join(' | '))
      check(after.length === 0, "the advisor doesn't answer the operator's update", after.map((m) => m.text.slice(0, 120)))
    }
  }
}

// What this run made goes again (scripts/check/cleanup.mjs), unless KEEP is set: it says what it
// couldn't. On a failure or Ctrl-C, clean.guard() runs it too.
await clean.finish()
if (failures) {
  console.log(failures + ' failed')
  process.exit(1)
}
console.log('all passed')

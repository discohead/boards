// A Session, end to end: real Haiku through the gateway, the board and computer tools, an approval
// parked and resumed (and one denied), and a wake-up delivered twice that runs once. It drives the
// app's /dev/session door (vite dev only) as a Seat would, and reads the bus to see what landed.
//   TOKEN=$(cd ../../packages/workbus && node scripts/issuer.mjs token jared https://workbus.dev/b/bus | tail -1)
//   TOKEN=… pnpm check:session [turn,board,tasks,computer,shared,approve,deny,sandbox]
// which starts the dev servers through scripts/with-containers.mjs (the sandbox part runs a container:
// ports on 127.0.0.1 only, removed after); or, with the servers running already,
//   node scripts/session-check.mjs http://127.0.0.1:8831 http://127.0.0.1:8832 [parts]
// Each check makes one to three tiny model calls.
import { busClient, cleaner } from './check/cleanup.mjs'
const [app = 'http://127.0.0.1:8831', bus = 'http://127.0.0.1:8832', only] = process.argv.slice(2)
const token = process.env.TOKEN
if (!token) throw new Error('set TOKEN: a board token for the bus (see the top of this file)')
const pick = only ? new Set(only.split(',')) : null
const run = Math.random().toString(36).slice(2, 8)

let failures = 0
const check = (ok, what, detail = '') => {
  if (!ok) failures++
  console.log((ok ? 'ok   ' : 'FAIL ') + what + (detail === '' ? '' : '  ' + JSON.stringify(detail)))
}

async function session(seat, thread, call, ...args) {
  const response = await fetch(app + '/dev/session', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ seat, thread, call, args }) })
  if (call === 'watch') return response
  const body = await response.json()
  if (!response.ok) throw new Error(call + ': ' + (body?.error ?? response.status))
  return body
}

const clean = cleaner({ owner: busClient(bus + '/b/bus', { authorization: 'Bearer ' + token }) }).guard()
clean.marker(run)
async function board(path, body) {
  const response = await fetch(bus + '/b/bus' + path, {
    method: body ? 'POST' : 'GET',
    headers: { authorization: 'Bearer ' + token, ...(body ? { 'content-type': 'application/json' } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}),
  })
  const answer = await response.json()
  return body ? clean.note(path, answer) : answer
}

/** The session's transcript as the seam's events, read for a moment. */
async function transcript(seat, thread) {
  const response = await session(seat, thread, 'watch')
  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let text = ''
  const stop = setTimeout(() => reader.cancel(), 1500)
  for (;;) {
    const { value, done } = await reader.read().catch(() => ({ done: true }))
    if (done) break
    text += decoder.decode(value, { stream: true })
  }
  clearTimeout(stop)
  return text.split('\n').filter(Boolean).map((line) => JSON.parse(line))
}

const ada = (tools, more = {}) => ({
  key: 'ada', name: 'Ada', handle: 'ada', team: 'eng', can: 'all', tools,
  prompt: { charter: 'You are an engineer. Be brief: answer in one short line.' },
  revision: run + ':' + tools.join(',') + ':' + JSON.stringify(more), ...more,
})
const turn = (text) => ({ type: 'turn', parts: [{ type: 'text', text }] })
const thread = async (text) => (await board('/messages', { channel: 'eng', text })).message.id

async function heldIn(thread) {
  for (let i = 0; i < 40; i++) {
    const held = (await session('ada', thread, 'inspect')).approvals.find((a) => a.state === 'held')
    if (held) return held
    await new Promise((resolve) => setTimeout(resolve, 1000))
  }
  return null
}

if (!pick || pick.has('turn')) {
  const t = 'turn-' + run
  await session('ada', t, 'configure', ada([]))
  const first = await session('ada', t, 'submit', turn('Say hi in three words.'), { operationId: 'cursor-1', task: 'check-' + run })
  const answered = await session('ada', t, 'wait', 'cursor-1', 60000)
  check(first.accepted && answered.status === 'done' && answered.text?.length > 0, 'a turn is answered by Haiku', answered.text ?? answered.reason)
  const u = answered.usage
  check(/claude-haiku-5/.test(u.model ?? '') && u.steps === 1 && u.tokens.output > 0 && u.cost > 0, 'its usage: the model, one step, tokens, and cost', u)
  check(u.logs.length === u.steps, 'every response has its gateway log ID', u.logs)
  const again = await session('ada', t, 'submit', turn('Say hi in three words.'), { operationId: 'cursor-1' })
  const after = await session('ada', t, 'wait', 'cursor-1', 60000)
  check(again.accepted === false && after.usage.steps === 1, 'the same wake-up delivered twice runs once', { accepted: again.accepted, steps: after.usage.steps })
}

if (!pick || pick.has('board')) {
  const t = 'board-' + run
  const text = 'hello from ada ' + run
  await session('ada', t, 'configure', ada(['board']))
  await session('ada', t, 'submit', turn('Post exactly "' + text + '" in the channel eng with board_post, then answer "posted".'), { operationId: 'cursor-1' })
  const answered = await session('ada', t, 'wait', 'cursor-1', 120000)
  check(answered.usage.tools.some((tool) => tool.name === 'board_post' && tool.ok), 'board_post ran', answered.usage.tools)
  const posted = (await board('/messages?channel=eng&limit=500')).messages.find((m) => m.text === text)
  check(posted?.by?.actor === 'worker:workbus-app+ada', "the post is on the bus, as the seat's actor", posted?.by)
}

if (!pick || pick.has('tasks')) {
  const t = 'tasks-' + run
  await session('ada', t, 'configure', ada(['board']))
  await session('ada', t, 'submit', turn('In the channel eng, use task_create_many to make two tasks: key "a", text "first ' + run + '"; and key "b", text "second ' + run + '", which needs "a". Then task_claim the first and task_complete it with the result "done". Answer "ok".'), { operationId: 'cursor-1' })
  const answered = await session('ada', t, 'wait', 'cursor-1', 120000)
  const ran = answered.usage.tools.filter((tool) => tool.ok).map((tool) => tool.name)
  check(['task_create_many', 'task_claim', 'task_complete'].every((name) => ran.includes(name)), 'task_create_many, task_claim, and task_complete ran', answered.usage.tools)
  const tasks = (await board('/tasks?channel=eng&state=all&limit=500')).tasks.map((row) => row.message)
  const first = tasks.find((m) => m.text === 'first ' + run)
  const second = tasks.find((m) => m.text === 'second ' + run)
  check(first?.task.state === 'completed' && first.by.actor === 'worker:workbus-app+ada', 'the first is completed, by the seat', first?.task)
  check(second?.task.needs?.includes(first?.id) && second.task.state === 'ready', 'the second needs the first, and is ready now that it is done', second?.task)
}

if (!pick || pick.has('computer')) {
  const t = 'computer-' + run
  const n = 100 + Math.floor(Math.random() * 900)
  await session('ada', t, 'configure', ada(['computer']))
  await session('ada', t, 'submit', turn('Use write to create /workspace/n.js containing: export default () => ' + n + ' * 7. Then use exec with command: import f from "./n.js"; export default () => f(). Answer with only the result.'), { operationId: 'cursor-1' })
  const answered = await session('ada', t, 'wait', 'cursor-1', 120000)
  const names = answered.usage.tools.filter((tool) => tool.ok).map((tool) => tool.name)
  check(names.includes('write') && names.includes('exec'), 'write and exec ran', answered.usage.tools)
  const files = (await session('ada', t, 'inspect')).files.map((f) => f.name)
  check(files.includes('n.js'), "the file is in the session's workspace", files)
  const ran = (await transcript('ada', t)).find((e) => e.type === 'message' && e.message.tool?.name === 'exec' && e.message.tool.ok)
  check(ran && JSON.parse(ran.message.text).result === n * 7, 'exec ran the file in a Dynamic Worker: its result is ' + n * 7, ran?.message.text)
}

if (!pick || pick.has('shared')) {
  // The workspace is the seat's: one thread writes a module, another thread of the same seat runs it, and another seat sees nothing.
  const n = 100 + Math.floor(Math.random() * 900)
  const path = '/workspace/shared-' + run + '.js'
  const one = 'shared-a-' + run
  const two = 'shared-b-' + run
  await session('ada', one, 'configure', ada(['computer']))
  await session('ada', one, 'submit', turn('Use write to create ' + path + ' containing: export default () => ' + n + ' + 1. Answer "written".'), { operationId: 'cursor-1' })
  const wrote = await session('ada', one, 'wait', 'cursor-1', 120000)
  check(wrote.usage.tools.some((tool) => tool.name === 'write' && tool.ok), 'one thread writes the module', wrote.usage.tools)
  await session('ada', two, 'configure', ada(['computer']))
  await session('ada', two, 'submit', turn('Use exec with command: import f from "' + path + '"; export default () => f(). Answer with only the result.'), { operationId: 'cursor-1' })
  await session('ada', two, 'wait', 'cursor-1', 120000)
  const ran = (await transcript('ada', two)).find((e) => e.type === 'message' && e.message.tool?.name === 'exec' && e.message.tool.ok)
  check(ran && JSON.parse(ran.message.text).result === n + 1, "another thread of the seat runs it: its result is " + (n + 1), ran?.message.text)
  const bob = { ...ada(['computer']), key: 'bob', name: 'Bob', handle: 'bob' }
  const three = 'shared-c-' + run
  await session('bob', three, 'configure', bob)
  await session('bob', three, 'submit', turn('Use read on ' + path + '. If it fails, answer "missing".'), { operationId: 'cursor-1' })
  const other = await session('bob', three, 'wait', 'cursor-1', 120000)
  const files = (await session('bob', three, 'inspect')).files.map((f) => f.name)
  check(!files.includes('shared-' + run + '.js') && !other.usage.tools.some((tool) => tool.name === 'read' && tool.ok), 'another seat sees nothing of it', { files, tools: other.usage.tools, text: other.text })
}

if (!pick || pick.has('serial')) {
  // No model: five read-wait-append calls at once on one seat's workspace each see the last one's write.
  const seat = 'serial-' + run
  const path = '/workspace/count.txt'
  await session(seat, 'x', 'workspace.execute', { id: 'w0', name: 'write', arguments: { path, content: '' } })
  const append = (i) => session(seat, 'x', 'workspace.execute', { id: 'e' + i, name: 'exec', arguments: { command: "import { readFile, writeFile } from 'node:fs/promises'; export default async () => { const t = await readFile('" + path + "', 'utf8'); await new Promise((r) => setTimeout(r, 200)); await writeFile('" + path + "', t + 'x'); return t.length }" } })
  await Promise.all([0, 1, 2, 3, 4].map(append))
  const read = await session(seat, 'x', 'workspace.execute', { id: 'r', name: 'read', arguments: { path } })
  const text = read.content.map((part) => part.text).join('')
  check(/xxxxx/.test(text) && !/xxxxxx/.test(text), "the workspace runs one call at a time: five appends at once leave five x's", text)
}

const gated = ada(['board', 'computer'], { approve: { exec: 'approval' } })

if (!pick || pick.has('approve')) {
  const t = await thread('approve check ' + run)
  await session('ada', t, 'configure', gated)
  await session('ada', t, 'submit', turn('Use exec with command: export default () => "ran " + (40 + 2). Answer with only its result.'), { operationId: 'cursor-1' })
  const held = await heldIn(t)
  check(held?.tool === 'exec' && held.kind === 'approval', 'exec parks for an approval', held)
  const task = held && (await board('/tasks?state=blocked&limit=500')).tasks.find((row) => row.message.id === held.id)
  check(task?.message.task.blocked?.kind === 'approval' && task.message.by.actor === 'worker:workbus-app+ada', 'a task is held for the principal on the bus, kind approval', task?.message.task)
  const pending = await session('ada', t, 'inspect')
  check(pending.pending.some((p) => p.operationId === 'cursor-1' && p.status === 'running'), 'the run waits, parked', pending.pending)
  const yes = held && (await session('ada', t, 'submit', { type: 'approval', approvalId: held.id, approved: true }, { operationId: 'cursor-2' }))
  const twice = held && (await session('ada', t, 'submit', { type: 'approval', approvalId: held.id, approved: false }, { operationId: 'cursor-3' }))
  check(yes?.accepted === true && twice?.accepted === false, 'the answer is taken once', { yes, twice })
  // The model may call exec again after the first runs: each call asks, so approve any more until the run answers.
  let answered = null
  for (let i = 0; i < 6 && !answered; i++) {
    answered = await session('ada', t, 'wait', 'cursor-1', 20000).catch(() => null)
    if (answered) break
    const more = (await session('ada', t, 'inspect')).approvals.filter((a) => a.state === 'held')
    for (const a of more) await session('ada', t, 'submit', { type: 'approval', approvalId: a.id, approved: true }, { operationId: 'cursor-more-' + a.id })
  }
  check(answered?.status === 'done' && answered.usage.tools.some((tool) => tool.name === 'exec' && tool.ok), 'approved, exec runs and the run answers', { text: answered?.text, tools: answered?.usage.tools })
}

// The sandbox tier with Haiku: sandbox_exec waits for the principal like exec; approved, it runs in
// the session's container, and the run's usage carries the container's time as sandbox:basic.
if (pick?.has('sandbox')) {
  const t = await thread('sandbox check ' + run)
  await session('ada', t, 'configure', ada(['board', 'sandbox'], { approve: { sandbox_exec: 'approval' } }))
  await session('ada', t, 'submit', turn('Use sandbox_exec once with command: node -e "console.log(6*7)". Answer with only its output.'), { operationId: 'cursor-1' })
  const held = await heldIn(t)
  check(held?.tool === 'sandbox_exec', 'sandbox_exec parks for an approval', held)
  if (held) await session('ada', t, 'submit', { type: 'approval', approvalId: held.id, approved: true }, { operationId: 'cursor-2' })
  let answered = null
  for (let i = 0; i < 8 && !answered; i++) {
    answered = await session('ada', t, 'wait', 'cursor-1', 30000).catch(() => null)
    if (answered) break
    for (const a of (await session('ada', t, 'inspect')).approvals.filter((one) => one.state === 'held')) await session('ada', t, 'submit', { type: 'approval', approvalId: a.id, approved: true }, { operationId: 'cursor-more-' + a.id })
  }
  const ran = answered?.usage.tools.find((tool) => tool.name === 'sandbox_exec' && tool.ok)
  check(Boolean(ran) && answered.text?.includes('42'), 'approved, it runs in the container and the run answers 42', { text: answered?.text, tools: answered?.usage.tools })
  const box = answered?.usage.tools.find((tool) => tool.name === 'sandbox:basic')
  check(Boolean(box) && box.ms >= 5 * 60_000, "the run's tools carry the container's time (with the sleep tail of the container it started)", box)
  // Its container doesn't outlive the check (local containers publish their ports on every interface).
  await session('ada', t, 'sandboxReset')
}

if (!pick || pick.has('deny')) {
  const t = await thread('deny check ' + run)
  await session('ada', t, 'configure', gated)
  await session('ada', t, 'submit', turn('Use exec with command: export default () => 1. If it is blocked, answer "blocked" and nothing else.'), { operationId: 'cursor-1' })
  const held = await heldIn(t)
  check(held?.tool === 'exec', 'exec parks for an approval', held)
  if (held) await session('ada', t, 'submit', { type: 'approval', approvalId: held.id, approved: false, reason: 'not now' }, { operationId: 'cursor-2' })
  const answered = await session('ada', t, 'wait', 'cursor-1', 120000)
  check(answered.usage.tools.some((tool) => tool.name === 'exec' && !tool.ok) && !answered.usage.tools.some((tool) => tool.name === 'exec' && tool.ok), 'denied, exec is blocked and never runs', answered.usage.tools)
  const result = (await transcript('ada', t)).find((e) => e.type === 'message' && e.message.tool?.name === 'exec' && e.message.tool.ok === false)
  check(/denied/.test(result?.message.text ?? ''), 'the model reads that the principal denied it', result?.message.text)
}

// What this run made goes again (scripts/check/cleanup.mjs), unless KEEP is set: it says what it
// couldn't. On a failure or Ctrl-C, clean.guard() runs it too.
await clean.finish()
if (failures) {
  console.log(failures + ' failed')
  process.exit(1)
}
console.log('all passed')

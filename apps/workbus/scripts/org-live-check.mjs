// The org on a real bus and app (design/workbus.md §4.4, §4.5, §5.2, §5.5): seeding is idempotent,
// an edit to a seat doc re-reconciles through the reconciler's wake (the seat's wake updates once,
// by revision), a bad edit gets one reply in its thread and changes nothing, a Seat takes a
// delivery once however often it comes, and (with "dm") a DM to @op wakes the operator, which
// makes two tasks for the engineer, the second needing the first, and the engineer wakes.
//   pnpm dev:bus & pnpm dev   (the bus's org set up: node scripts/org-setup.ts <board url> <owner token>)
//   TOKEN=<owner token> node scripts/org-live-check.mjs http://127.0.0.1:8831 http://127.0.0.1:8832 [boot,edit,bad,dedupe,dm,run,docwake,budget,hire,watchdog,sequence,letgo]
// Only "dm" and "run" call a model (Haiku): dm the operator's and the engineer's first turns, run the
// whole of the phase-2 run, approval and all.
const [app = 'http://127.0.0.1:8831', bus = 'http://127.0.0.1:8832', only = 'boot,edit,bad,dedupe'] = process.argv.slice(2)
// Auth: TOKEN, a board token (bearer); or ACCESS_TOKEN, a person's Access token for workbus.dev
// (cloudflared access token -app=https://workbus.dev), sent as cf-access-token through Access.
// With ACCESS_TOKEN the seats are read through the app's GET /api/seats/<key> (live), not /dev/seat.
const token = process.env.TOKEN
const access = process.env.ACCESS_TOKEN
if (!token && !access) throw new Error('set TOKEN (a board token) or ACCESS_TOKEN (an Access token for the app)')
const auth = access ? { 'cf-access-token': access } : { authorization: 'Bearer ' + token }
const live = Boolean(access)
const pick = new Set(only.split(','))
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

let failures = 0
const check = (ok, what, detail = '') => {
  if (!ok) failures++
  console.log((ok ? 'ok   ' : 'FAIL ') + what + (detail === '' ? '' : '  ' + JSON.stringify(detail)))
}

async function board(method, path, body) {
  const response = await fetch(bus + '/b/bus' + path, { method, headers: { ...auth, ...(body ? { 'content-type': 'application/json' } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) })
  const answer = await response.json()
  if (!response.ok) throw new Error(method + ' ' + path + ': ' + response.status + ' ' + JSON.stringify(answer))
  return answer
}
/** A seat's status: live through the app's API, in dev through its door. */
async function status(key) {
  if (!live) return seat({ seat: key, call: 'status' })
  const response = await fetch(app + '/api/seats/' + key, { headers: auth })
  if (!response.ok) throw new Error('GET /api/seats/' + key + ': ' + response.status)
  return response.json()
}
/** A file in a seat's workspace, as text. */
async function readFile(key, path) {
  if (live) return (await (await fetch(app + '/api/seats/' + key + '?file=' + encodeURIComponent(path), { headers: auth })).json()).text
  const read = await seat({ via: 'session', seat: key, call: 'workspace.execute', args: [{ id: 'check-read', name: 'read', arguments: { path } }] })
  return (read?.content ?? []).map((part) => part.text ?? '').join('')
}
async function seat(body) {
  if (body.via === 'session') {
    const response = await fetch(app + '/dev/session', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ seat: body.seat, thread: 'x', call: body.call, args: body.args }) })
    return response.json()
  }
  const response = await fetch(app + '/dev/seat', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
  const answer = await response.json()
  if (!response.ok) throw new Error('dev/seat ' + body.call + ': ' + (answer?.error ?? response.status))
  return answer
}
const wakeOf = async (key) => (await board('GET', '/wakes')).wakes.find((wake) => wake.key === key)
/** Polls until fn answers something truthy, or the time is up. */
async function until(fn, ms = 15000) {
  const end = Date.now() + ms
  for (;;) {
    const value = await fn()
    if (value || Date.now() > end) return value
    await sleep(500)
  }
}
/** Rewrites a seat doc's block, as the owner. */
async function editBlock(path, change) {
  const { doc, body } = await board('GET', '/docs?path=' + path)
  const fence = /(```json#seat@[12]\n)([\s\S]*?)(\n```)/
  const data = JSON.parse(fence.exec(body)[2])
  change(data)
  const next = body.replace(fence, (_, open, _old, close) => open + JSON.stringify(data, null, 2) + close)
  return (await board('POST', '/docs/' + doc.id + '/edit', { revision: doc.revision, body: next })).doc
}

if (pick.has('boot')) {
  const first = await seat({ call: 'boot' })
  const second = await seat({ call: 'boot' })
  check(second.seeded.length === 0 && second.found.length === first.seeded.length + first.found.length, 'a second boot seeds nothing and finds every seed doc', second.found)
  check(second.reconciler === 'same', "the reconciler's wake is the same", second.reconciler)
  check(second.pass.applied.every((applied) => applied.wake === 'same' && applied.config.applied === false), "every seat's wake and config are the same", second.pass.applied.map((a) => a.seat + ' ' + a.wake + ' ' + a.config.applied))
  const threads = (await board('GET', '/threads?channel=org/&limit=50')).threads.filter((thread) => thread.message.doc)
  const paths = threads.map((thread) => thread.message.doc.path).sort()
  check(new Set(paths).size === paths.length && ['org/seats/ada', 'org/seats/op', 'org/structure', 'org/teams/eng'].every((path) => paths.includes(path)), 'org/ holds each seed doc once', paths)
  const op = await wakeOf('seat.op')
  check(op?.actor === 'worker:workbus-app+op' && op.can.includes('dm/op/='), "op's wake is the seat itself, narrowed, with its own DM", op && { actor: op.actor, can: op.can })
  void first
}

if (pick.has('edit')) {
  const before = await wakeOf('seat.ada')
  const doc = await editBlock('org/seats/ada', (data) => (data.sessions = (data.sessions ?? 1) === 2 ? 3 : 2))
  const revision = Number(doc.revision)
  const status = await until(async () => {
    const now = await seat({ seat: 'ada', call: 'status' })
    return now.revision === revision ? now : null
  })
  check(status?.revision === revision, "ada's Seat takes the edit's revision through the reconciler's wake", { revision, seat: status?.revision })
  const after = await wakeOf('seat.ada')
  check(after.revision === revision && before.revision < revision, "ada's wake moves to the edit's revision", { before: before.revision, after: after.revision })
  const again = await seat({ call: 'reconcile' })
  const ada = again.applied.find((applied) => applied.seat === 'ada')
  check(ada.wake === 'same' && ada.config.applied === false, 'a second pass at that revision changes nothing', ada)
}

if (pick.has('bad')) {
  const held = (await seat({ seat: 'ada', call: 'status' })).revision
  const doc = await editBlock('org/seats/ada', (data) => (data.can['eng/'] = 'all'))
  const since = Date.now() - 2000
  const ours = (thread) => thread.replies.filter((reply) => reply.text.startsWith('This revision of org/seats/ada') && Date.parse(reply.createdAt) >= since)
  const replies = await until(async () => {
    const found = ours(await board('GET', '/messages/' + doc.id))
    return found.length ? found : null
  })
  check(replies?.length === 1 && /can gives sync and manage at eng\/, more than the app holds/.test(replies[0].text), 'a can wider than the app holds gets one reply in the thread, saying why', replies?.map((reply) => reply.text))
  check(replies?.[0]?.by.actor === 'worker:workbus-app', 'the reply is the reconciler, as the app', replies?.[0]?.by)
  const status = await seat({ seat: 'ada', call: 'status' })
  check(status.revision === held && status.runtime.can['eng/'] !== 'all', 'ada keeps the config it had', { held, now: status.revision })
  check((await wakeOf('seat.ada')).revision === held, "ada's wake keeps its revision")
  // The pass again, twice, as a redelivery of the same doc's event makes it: still one reply.
  const pass = await seat({ call: 'reconcile', args: [doc.id] })
  await seat({ call: 'reconcile', args: [doc.id] })
  const thread = await board('GET', '/messages/' + doc.id)
  check(ours(thread).length === 1, 'passes again leave one reply', pass.replies)
  // Put it back, so the next run starts clean.
  await editBlock('org/seats/ada', (data) => (data.can['eng/'] = ['read', 'post', 'react', 'label', 'edit']))
  const restored = await until(async () => ((await seat({ seat: 'ada', call: 'status' })).revision > held ? true : null))
  check(restored === true, 'the fixed doc applies again')
}

if (pick.has('dedupe')) {
  const { runtime } = await seat({ seat: 'op', call: 'status' })
  const key = 'dedupe' + Math.random().toString(36).slice(2, 7)
  // A paused seat queues and starts nothing: no model is called.
  const paused = { ...runtime, key, state: 'paused' }
  await seat({ seat: key, call: 'configure', args: [paused, 1] })
  const event = { cursor: '424242', type: 'message.posted', message: { id: '77', re: null, channel: 'dm/' + key, text: 'hi' } }
  const context = { board: 'bus', wake: 'seat.' + key, principal: 'worker:workbus-app', actor: 'worker:workbus-app+' + key, rules: ['dm'], match: 'm', attempt: 1 }
  const one = await seat({ seat: key, call: 'wake', args: [event, context] })
  const two = await seat({ seat: key, call: 'wake', args: [event, { ...context, attempt: 2 }] })
  const status = await seat({ seat: key, call: 'status' })
  // (A new seat also queues its introduction, #30: count this thread's.)
  const forThread = status.wakes.filter((wake) => wake.thread === '77')
  check(one.queued === true && two.queued === false && forThread.length === 1, 'a delivery made twice is queued once', { one, two, wakes: forThread })
  check(status.state === 'paused', 'a paused seat starts nothing', status.state)
  const older = await seat({ seat: key, call: 'configure', args: [{ ...paused, sessions: 9 }, 0] })
  check(older.applied === false && (await seat({ seat: key, call: 'status' })).runtime.sessions === paused.sessions, 'an older revision changes nothing', older)
  // A task one of its sessions holds is the principal's: its other events (its ready, in a queue the seat serves) start nothing.
  await seat({ seat: key, call: 'held', args: [{ approvalId: '500', thread: '77', operationId: null }] })
  const ready = await seat({ seat: key, call: 'wake', args: [{ cursor: '424243', type: 'task.ready', message: { id: '500', re: null, channel: 'eng/queue', text: 'asks to run exec', task: { state: 'ready' } } }, context] })
  check(ready.queued === false, "a held task's own events don't wake the seat", ready)
  // A doc's edit is news only to its docs rule: one that mentions the seat in its body doesn't wake it.
  const edited = { cursor: '424244', type: 'doc.edited', message: { id: '88', re: null, channel: 'org/seats', text: 'ask @' + key } }
  const byMention = await seat({ seat: key, call: 'wake', args: [edited, { ...context, rules: ['mention'] }] })
  const byDocs = await seat({ seat: key, call: 'wake', args: [{ ...edited, cursor: '424245' }, { ...context, rules: ['docs'] }] })
  check(byMention.queued === false && byDocs.queued === true, "a doc's edit wakes a seat by its docs rule, not by a mention in the body", { byMention, byDocs })
  await seat({ seat: key, call: 'configure', args: [null, 0] })
  check((await seat({ seat: key, call: 'status' })).state === 'retired', 'no config retires it')
}

if (pick.has('dm')) {
  const posted = await board('POST', '/messages', { channel: 'dm/op', text: 'Something small for Ada: first, write hello.txt containing the word hello; then, as a second step that needs the first, append a line saying world. Two tasks, please.' })
  const root = posted.message.id
  const woke = await until(async () => (await seat({ seat: 'op', call: 'status' })).wakes.find((wake) => wake.thread === root && wake.state === 'done'), 60000)
  check(Boolean(woke), "the DM wakes @op through its wake, and its run ends", woke)
  const made = await until(async () => {
    const { tasks } = await board('GET', '/tasks?channel=eng/queue&state=all&limit=100')
    const mine = tasks.map((entry) => entry.message).filter((message) => message.by.actor === 'worker:workbus-app+op' && Date.parse(message.createdAt) >= Date.parse(posted.message.createdAt)).map((message) => ({ id: message.id, ...message.task }))
    return mine.length >= 2 ? mine : null
  }, 30000)
  const first = made?.find((task) => task.needs.length === 0)
  const second = made?.find((task) => task.needs.length > 0)
  check(Boolean(first && second && second.needs.includes(first.id)), 'op made two tasks, the second needing the first', made?.map((task) => ({ id: task.id, needs: task.needs, for: task.for })))
  check(Boolean(made?.every((task) => task.for === 'worker:workbus-app+ada')), 'both are for the engineer')
  const reply = (await board('GET', '/messages/' + root)).replies.find((message) => message.by.actor === 'worker:workbus-app+op')
  check(Boolean(reply), 'op replied in its DM', reply?.text)
  const adaWoke = await until(async () => (await seat({ seat: 'ada', call: 'status' })).wakes.find((wake) => wake.thread === first?.id), 30000)
  check(Boolean(adaWoke), 'the engineer wakes on the assignment', adaWoke)
  const runs = (await seat({ seat: 'op', call: 'status' })).runs
  check(runs.some((run) => run.thread === root && run.cost > 0 && run.tokens.output > 0), "op's run is recorded with its cost", runs.find((run) => run.thread === root))
}

// The phase-2 run (design/workbus.md §12): the principal asks @op for something small; op makes two
// tasks for ada, the second needing the first; ada does them in its workspace; one step (an exec)
// waits for the principal, who approves it from the inbox; and the cost shows on each seat.
if (pick.has('run')) {
  const file = 'notes-' + Math.random().toString(36).slice(2, 7) + '.txt'
  const posted = await board('POST', '/messages', { channel: 'dm/op', text: 'Two small steps for Ada, in order. First: write ' + file + ' containing the line hello. Second, once the first is done: append the line world to ' + file + ', then run a short exec that reads ' + file + ' back and returns its lines, to check it.' })
  const since = Date.parse(posted.message.createdAt)
  const made = await until(async () => {
    const { tasks } = await board('GET', '/tasks?channel=eng/queue&state=all&limit=100')
    const mine = tasks.map((entry) => entry.message).filter((message) => message.by.actor === 'worker:workbus-app+op' && Date.parse(message.createdAt) >= since).map((message) => ({ id: message.id, ...message.task }))
    return mine.length >= 2 ? mine : null
  }, 60000)
  const first = made?.find((task) => task.needs.length === 0)
  const second = made?.find((task) => task.needs.length > 0)
  check(Boolean(first && second && second.needs.includes(first.id) && made.every((task) => task.for === 'worker:workbus-app+ada')), 'op made two tasks for ada, the second needing the first', made?.map((task) => ({ id: task.id, needs: task.needs, for: task.for })))
  // The hold: a task blocked for the principal, kind approval, by ada; the inbox lists held tasks.
  const hold = await until(async () => {
    const { tasks } = await board('GET', '/tasks?state=blocked&limit=100')
    return tasks.map((entry) => entry.message).find((message) => message.task.blocked?.kind === 'approval' && message.by.actor === 'worker:workbus-app+ada' && Date.parse(message.createdAt) >= since) ?? null
  }, 180000)
  check(Boolean(hold), 'a step waits for the principal: a task held for approval, by ada', hold && { id: hold.id, reason: hold.task.blocked.reason })
  // Held in ada's own DM, never in the queue it serves (#19).
  check(hold?.channel === 'dm/ada', "the approval task is held in ada's DM, not in eng/queue", hold?.channel)
  const waiting = await status('ada')
  check(waiting.holds.some((held) => held.task === hold?.id && held.state === 'held'), "ada's Seat knows the hold and which thread it parks", waiting.holds)
  // The principal approves from the inbox: this hold, and any other step ada asks for on the way.
  const approved = new Set()
  const approve = async () => {
    const { tasks } = await board('GET', '/tasks?state=blocked&limit=100')
    for (const message of tasks.map((entry) => entry.message))
      if (message.task.blocked?.kind === 'approval' && message.by.actor === 'worker:workbus-app+ada' && Date.parse(message.createdAt) >= since && !approved.has(message.id)) {
        await board('POST', '/tasks/' + message.id + '/unblock', { decision: 'approved', note: 'go ahead' })
        approved.add(message.id)
      }
  }
  const done = await until(async () => {
    await approve()
    const { tasks } = await board('GET', '/tasks?channel=eng/queue&state=all&limit=100')
    const both = tasks.map((entry) => entry.message).filter((message) => message.id === first?.id || message.id === second?.id)
    return both.length === 2 && both.every((message) => message.task.state === 'completed') ? both : null
  }, 180000)
  check(Boolean(done), 'ada completed both tasks', { approved: [...approved], results: done?.map((message) => ({ id: message.id, result: message.task.result })) })
  check(approved.size === 1, 'the principal was asked once: one held task in the inbox', [...approved])
  console.log('     the DM: #' + posted.message.id + ' (cursor ' + posted.cursor + '); tasks #' + first?.id + ' and #' + second?.id + '; the hold #' + hold?.id)
  // The answer's own operation ends when the one it resumed does.
  const answered = await until(async () => (await status('ada')).holds.find((held) => held.task === hold?.id && ['answered', 'closed'].includes(held.state)))
  check(Boolean(answered), "the approval reached ada's parked session through its Seat", answered)
  // The answered hold ends: completed with the decision, never claimed, and nothing of it left ready.
  const ended = await until(async () => {
    const view = (await board('GET', '/messages/' + hold?.id)).message
    return view.task.state === 'completed' ? view.task : null
  })
  check(Boolean(ended && /^Approved by the principal: go ahead/.test(ended.result ?? '') && ended.epoch === 0 && ended.claim === null), 'the approval task ends completed with the decision, and no one ever claimed it', ended && { state: ended.state, result: ended.result, epoch: ended.epoch, answer: ended.answer })
  const { tasks: ready } = await board('GET', '/tasks?state=ready&limit=100')
  const left = ready.map((entry) => entry.message).filter((message) => message.by.actor === 'worker:workbus-app+ada' && Date.parse(message.createdAt) >= since)
  check(left.length === 0, 'nothing ada held stays ready', left.map((message) => message.id))
  const text = await readFile('ada', '/workspace/' + file)
  check(/hello[\s\S]*world/.test(text), "the file is in ada's workspace, both lines", text)
  for (const key of ['op', 'ada']) {
    const { spend, runs } = await status(key)
    check(spend.cost > 0 && spend.runs > 0 && runs.every((run) => run.seat === key), 'the cost shows on ' + key, spend)
    // The evidence: each run's operation (the wake's cursor), cost, and gateway log IDs.
    console.log('     ' + key + ' runs: ' + JSON.stringify(runs.map((run) => ({ operation: run.operation, thread: run.thread, task: run.task, cost: run.cost, logIds: run.logIds }))))
  }
}

// What a seat doc's edit wakes: no one (its body mentions @ada and @op), while a comment on a doc
// that mentions @ada still wakes ada. The comment calls a model once (ada's turn on it).
if (pick.has('docwake')) {
  const runsOf = async (key) => (await status(key)).spend.runs
  const before = { op: await runsOf('op'), ada: await runsOf('ada') }
  const doc = await editBlock('org/seats/ada', (data) => (data.sessions = (data.sessions ?? 1) === 2 ? 3 : 2))
  await until(async () => ((await status('ada')).revision === Number(doc.revision) ? true : null))
  await sleep(10000)
  const [op, ada] = [await status('op'), await status('ada')]
  check(!op.wakes.some((wake) => wake.thread === doc.id) && !ada.wakes.some((wake) => wake.thread === doc.id), "an edit to ada's seat doc wakes neither seat", { op: op.wakes.filter((wake) => wake.thread === doc.id), ada: ada.wakes.filter((wake) => wake.thread === doc.id) })
  check(op.spend.runs === before.op && ada.spend.runs === before.ada, 'and starts no run', { before, after: { op: op.spend.runs, ada: ada.spend.runs } })
  const comment = await board('POST', '/messages', { re: doc.id, text: '@ada no action needed: just checking that a mention on a doc reaches you. Reply with one word.' })
  const woke = await until(async () => (await status('ada')).wakes.find((wake) => wake.thread === doc.id), 30000)
  check(Boolean(woke), 'a comment on the doc that mentions @ada wakes ada', { comment: comment.message.id, woke })
}

// Budgets and pauses (design/workbus.md §5.6), on the dev stack: ada paused, a tiny budget, and runs
// of a known cost recorded through the Seat's own ended() (no model), then the real queue: the
// alert at 80%, the limit at 100% with ada over budget and a DM's wake waiting, the limit held again
// when answered while still over, and a raised budget closing it and running the wake (one Haiku turn).
// Its budget tasks are once per period, so it runs on a board where ada has none yet this month.
if (pick.has('budget')) {
  const blockOf = async () => (await board('GET', '/docs?path=org/seats/ada'))
  const setAda = async (change) => {
    const doc = await editBlock('org/seats/ada', change)
    await until(async () => ((await status('ada')).revision === Number(doc.revision) ? true : null))
    return doc
  }
  void blockOf
  const dmTasks = async () => (await board('GET', '/tasks?channel=dm/ada&state=all&limit=100')).tasks.map((entry) => entry.message).filter((message) => /budget for /.test(message.text))
  const known = new Set((await dmTasks()).map((message) => message.id))
  const fresh = async () => (await dmTasks()).filter((message) => !known.has(message.id))
  const spent = (await status('ada')).spend.cost
  // The budget sits just above what ada has spent, so a known cost crosses it.
  const month = Math.round((spent + 0.01) * 1e6) / 1e6
  await setAda((data) => ((data.state = 'paused'), (data.budget = { month, alert: 0.8 })))
  check((await status('ada')).state === 'paused', 'a paused seat reads paused')
  // A DM while paused: its wake waits.
  const dm = (await board('POST', '/messages', { channel: 'dm/ada', text: 'Reply with the single word: ok.' })).message.id
  const waits = await until(async () => (await status('ada')).wakes.find((wake) => wake.thread === dm && wake.state === 'queued'))
  check(Boolean(waits), 'a wake that comes while paused is queued, not run', waits)
  let n = 0
  const cost = async (usd) => {
    const cursor = String(900000 + Math.floor(Math.random() * 99999))
    const context = { board: 'bus', wake: 'seat.ada', principal: 'worker:workbus-app', actor: 'worker:workbus-app+ada', rules: ['dm'], match: 'm', attempt: 1 }
    await seat({ seat: 'ada', call: 'wake', args: [{ cursor, type: 'message.posted', message: { id: 'b' + cursor, re: null, channel: 'dm/ada', text: 'cost' } }, context] })
    const iso = new Date().toISOString()
    await seat({ seat: 'ada', call: 'ended', args: ['seat.ada:' + cursor, { operationId: 'seat.ada:' + cursor, status: 'done', usage: { model: 'anthropic/claude-haiku-5.5', steps: 1, tokens: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 }, cost: usd, tools: [], logs: [], started: iso, ended: iso } }] })
    n++
  }
  await cost(0.0085)
  const alert = await until(async () => (await fresh()).find((message) => message.task?.blocked?.kind === 'budget'))
  check(Boolean(alert && /\(8\d%\)\.$/.test(alert.text)), 'at 80% one task is held for the principal, kind budget', alert && { id: alert.id, text: alert.text, channel: alert.channel })
  await cost(0.0005)
  check((await fresh()).length === 1, 'and only one, however many runs end past the alert', (await fresh()).map((message) => message.id))
  await board('POST', '/tasks/' + alert.id + '/unblock', { decision: 'approved', note: 'noted' })
  const noted = await until(async () => ((await board('GET', '/messages/' + alert.id)).message.task.state === 'completed' ? true : null))
  check(noted === true, 'answering the alert ends it')
  await cost(0.002)
  const limit = await until(async () => (await fresh()).find((message) => message.id !== alert.id && message.task?.blocked?.kind === 'budget'))
  check(Boolean(limit && /its limit, and has stopped starting runs \(1 wake-up waits\)/.test(limit.text)), 'at the limit a second task is held: it stopped, and one wake-up waits', limit && { id: limit.id, text: limit.text })
  await setAda((data) => (data.state = 'active'))
  const over = await status('ada')
  check(over.state === 'over_budget' && over.wakes.find((wake) => wake.thread === dm)?.state === 'queued', 'resumed but over budget: it reads over_budget, and the wake still waits', { state: over.state, wake: over.wakes.find((wake) => wake.thread === dm) })
  await board('POST', '/tasks/' + limit.id + '/unblock', { decision: 'approved' })
  const reheld = await until(async () => ((await board('GET', '/messages/' + limit.id)).message.task.blocked?.kind === 'budget' ? true : null))
  check(reheld === true, 'answering the limit task while still over holds it again', (await board('GET', '/messages/' + limit.id)).message.task.blocked)
  await setAda((data) => (data.budget = { month: Math.round((month + 1) * 1e6) / 1e6, alert: 0.8 }))
  const closed = await until(async () => ((await board('GET', '/messages/' + limit.id)).message.task.state === 'completed' ? (await board('GET', '/messages/' + limit.id)).message.task : null))
  check(Boolean(closed && /budget was raised/.test(closed.result ?? '')), 'a raised budget closes the limit task', closed?.result)
  const ran = await until(async () => (await status('ada')).wakes.find((wake) => wake.thread === dm && wake.state === 'done'), 90000)
  check(Boolean(ran), 'and the wake that waited runs', ran)
  const reply = (await board('GET', '/messages/' + dm)).replies.find((message) => message.by.actor === 'worker:workbus-app+ada')
  check(Boolean(reply), 'ada answered the DM that waited', reply?.text)
  void n
}

// Hiring from a template (design/workbus.md §5.7): the principal asks the operator for someone; the
// operator proposes a seat doc from org/templates as a new-doc proposal; the principal completes it;
// the reconciler provisions the seat, which introduces itself in its team's channel (or org) and its
// DM, and then does a small task. Calls Haiku: the operator's turn, the new seat's introduction,
// and its task.
if (pick.has('hire')) {
  const asked = await board('POST', '/messages', { channel: 'dm/op', text: 'We need someone to write release notes.' })
  const since = Date.parse(asked.message.createdAt)
  const proposal = await until(async () => {
    const { tasks } = await board('GET', '/tasks?channel=org/seats&state=all&limit=50')
    return tasks.map((entry) => entry.message).find((message) => (message.labels['board.doc.proposal'] ?? '').startsWith('new:org/seats/') && Date.parse(message.createdAt) >= since) ?? null
  }, 120000)
  const path = proposal?.labels['board.doc.proposal'].slice(4)
  const key = path?.split('/').pop()
  const block = proposal?.blocks?.find((one) => one.schema === 'seat')?.data
  check(Boolean(proposal && block && block.role === 'writer' && block.name && (block.handle ?? key)), 'op proposes a writer seat, from the template, as a new-doc proposal in org/seats', proposal && { id: proposal.id, path, name: block?.name, handle: block?.handle, budget: block?.budget, by: proposal.by.actor })
  check(Boolean(proposal && !/\{\{name\}\}|Hiring from this template/.test(proposal.text)), "the proposed charter is filled in, without the template's hiring notes", proposal?.text.slice(0, 400))
  const reply = await until(async () => (await board('GET', '/messages/' + asked.message.id)).replies.find((message) => message.by.actor === 'worker:workbus-app+op'), 30000)
  check(Boolean(reply), 'op replies in its DM', reply?.text)
  if (!proposal) throw new Error('no proposal to complete')
  // The principal completes it, as from the inbox: the doc is created, by the principal, as proposed.
  const done = await board('POST', '/tasks/' + proposal.id + '/complete', {})
  const state = (await board('GET', '/messages/' + proposal.id)).message.task.state
  check(state === 'completed', 'completing the proposal hires: the task completes', { state, answer: Object.keys(done) })
  const doc = await until(async () => (await board('GET', '/docs?path=' + path).catch(() => null)), 15000)
  check(Boolean(doc), 'and ' + path + ' exists', doc?.doc?.revision)
  const runtime = await until(async () => (await status(key).catch(() => null))?.runtime ?? null, 30000)
  check(Boolean(runtime && runtime.role === 'writer'), 'the reconciler provisions it: its Seat holds its config', runtime && { key: runtime.key, name: runtime.name, tools: runtime.tools, budget: runtime.budget })
  const wake = (await board('GET', '/wakes')).wakes.find((one) => one.key === 'seat.' + key)
  check(Boolean(wake && wake.actor === 'worker:workbus-app+' + key && wake.can.includes('dm/' + key + '/')), 'and its wake, as the seat, narrowed, with its DM', wake && { actor: wake.actor, can: wake.can })
  const actor = 'worker:workbus-app+' + key
  const intro = await until(async () => {
    const where = runtime?.team ?? 'org'
    const team = (await board('GET', '/messages?channel=' + where + '&limit=100')).messages?.find((message) => message.by.actor === actor) ?? null
    const dm = (await board('GET', '/messages?channel=dm/' + key + '&limit=50')).messages?.find((message) => message.by.actor === actor) ?? null
    return team && dm ? { team, dm } : null
  }, 120000)
  check(Boolean(intro), 'it introduces itself in ' + (runtime?.team ?? 'org') + ' and in dm/' + key, intro && { team: intro.team.text, dm: intro.dm.text })
  // A small task: release notes for something on the board.
  const task = (await board('POST', '/tasks', { channel: 'eng/queue', text: 'Write a two-line release note for "budgets and pauses": seats now hold a task for the principal at their budget alert and limit, and can be paused and resumed from their page. Put it in a doc in docs/notes, then complete this task with its path.', for: actor })).task
  const finished = await until(async () => { const one = (await board('GET', '/messages/' + task.id)).message.task; return one.state === 'completed' ? one : null }, 180000, 2000)
  check(Boolean(finished), 'it takes a small task and completes it', finished?.result)
  const notes = (await board('GET', '/threads?channel=docs/notes&limit=20')).threads.map((one) => one.message).filter((message) => message.doc && message.by.actor === actor)
  check(notes.length >= 1, 'its release note is a doc in docs/notes, by it', notes.map((message) => message.doc.path))
}

// The watchdog and the brief (design/workbus.md §8.6, §5.8), on the dev stack with WATCHDOG_STALL_MS
// small (8000) in the app's .dev.vars: a claim whose lease runs out, and a failed task, reach the
// operator once each as a notice with the facts; a seat's run past its limit is stopped, said in its
// thread, and raised; and the brief, written from the watchdog's facts, has the right numbers.
// Calls Haiku: ada's long run, and the operator's turns on the notices.
if (pick.has('watchdog')) {
  const wakes = (await board('GET', '/wakes')).wakes
  check(wakes.some((wake) => wake.key === 'watchdog' && wake.actor === 'worker:workbus-app') && wakes.some((wake) => wake.key === 'schedules.op' && wake.actor === 'worker:workbus-app+op'), "boot sets the app's watchdog wake and the operator's schedules wake", wakes.map((wake) => wake.key))
  const briefs = (await board('GET', '/schedules?channel=ops/briefs&all=true')).schedules
  check(briefs.length === 1 && (briefs[0].every === 86400000 || briefs[0].every === '1d'), 'the operator keeps one daily brief schedule in ops/briefs', briefs)
  const opNotices = async () => (await status('op')).wakes.filter((wake) => wake.id.startsWith('notice:'))
  // A claim whose lease runs out.
  const expiring = (await board('POST', '/tasks', { channel: 'ops/checks', text: 'Watchdog check: a claim left to run out.' })).task
  await board('POST', '/tasks/' + expiring.id + '/claim', { lease: 30 })
  const expired = await until(async () => (await opNotices()).find((wake) => wake.id.startsWith('notice:expired:') && wake.thread === expiring.id), 120000, 2000)
  check(Boolean(expired), 'a claim run out reaches the operator as a notice in the task thread', expired)
  // A failed task.
  const failing = (await board('POST', '/tasks', { channel: 'ops/checks', text: 'Watchdog check: a task that fails.' })).task
  const claim = (await board('POST', '/tasks/' + failing.id + '/claim', {})).claim
  await board('POST', '/tasks/' + failing.id + '/fail', { epoch: claim.epoch, token: claim.token, reason: 'the check fails it on purpose' })
  const failed = await until(async () => (await opNotices()).find((wake) => wake.id.startsWith('notice:failed:') && wake.thread === failing.id), 60000)
  check(Boolean(failed), 'a failed task reaches the operator as a notice', failed)
  // Once: the same events again change nothing (the watchdog dedupes; the operator's follow doesn't repeat them).
  await sleep(5000)
  const notices = await opNotices()
  check(notices.filter((wake) => wake.thread === expiring.id).length === 1 && notices.filter((wake) => wake.thread === failing.id).length === 1, 'each reaches it once', notices.map((wake) => wake.id))
  // A run past its limit: a long task for ada.
  const long = (await board('POST', '/tasks', { channel: 'eng/queue', text: 'Write a 400-word story about a lighthouse keeper into story.txt in your workspace, in four separate writes of about 100 words each (write, then read, then write again), using only the write and read tools (never exec), then complete this task.', for: 'worker:workbus-app+ada' })).task
  const stopped = await until(async () => (await status('ada')).wakes.find((wake) => wake.thread === long.id && wake.state === 'failed' && /stalled/.test(wake.error ?? '')), 120000, 1000)
  check(Boolean(stopped), "ada's run past its limit is stopped", stopped)
  const said = await until(async () => (await board('GET', '/messages/' + long.id)).replies.find((message) => message.by.actor === 'worker:workbus-app+ada' && /I stopped this run/.test(message.text)), 30000)
  check(Boolean(said), 'and it says so in the thread', said?.text)
  const raisedStall = await until(async () => (await opNotices()).find((wake) => wake.id.startsWith('notice:stalled:') && wake.thread === long.id), 30000)
  check(Boolean(raisedStall), 'and the operator hears of it', raisedStall)
  const run = (await status('ada')).runs.find((one) => one.thread === long.id)
  check(Boolean(run && (run.outcome === 'failed' || run.outcome === 'aborted') && /stalled/.test(run.error ?? '')), 'its run record says it was stopped', run && { outcome: run.outcome, error: run.error })
  // The brief: from the watchdog's facts, as the operator's schedule fires (a fake of its event, through the dev door).
  // Quiet first: nothing of op's or ada's running or queued, so the numbers hold still.
  const quiet = async () => { for (const key of ['op', 'ada']) { const queue = (await status(key)).queue; if ((queue.running ?? 0) + (queue.queued ?? 0) + (queue.held ?? 0) > 0) return false } return true }
  await until(async () => (await quiet()) && (await sleep(3000), await quiet()), 120000, 2000)
  const at = new Date().toISOString()
  const date = at.slice(0, 10)
  const fire = { cursor: '990' + Date.now(), type: 'message.posted', createdAt: at, message: { id: '0', re: null, channel: 'ops/briefs', text: 'The daily brief.', schedule: { id: 's1', n: 1 } } }
  await seat({ seat: 'op', call: 'wake', args: [fire, { board: 'bus', wake: 'schedules.op', principal: 'worker:workbus-app', actor: 'worker:workbus-app+op', rules: ['schedules'], match: 'm', attempt: 1 }] })
  const brief = await until(async () => (await board('GET', '/docs?path=ops/briefs/' + date).catch(() => null)), 30000)
  check(Boolean(brief && brief.body.startsWith('# Brief, ' + date)), 'the brief is written as ops/briefs/' + date + ', by the operator', brief && (await board('GET', '/messages/' + brief.doc.id)).message.by.actor)
  const text = brief?.body ?? ''
  check(text.includes('#' + failing.id + ' in ops/checks') && /## Failed\n\n- #/.test(text), 'it lists the failed task', text.slice(text.indexOf('## Failed'), text.indexOf('## Seats')))
  check(text.includes('expired, #' + expiring.id) && text.includes('failed, #' + failing.id) && text.includes('stalled, #' + long.id), 'and what the watchdog raised', text.slice(text.indexOf('## Raised')))
  const statuses = { op: await status('op'), ada: await status('ada') }
  for (const key of ['op', 'ada']) {
    const row = text.split('\n').find((line) => line.startsWith('| ' + key + ' |'))
    check(Boolean(row && row.includes('$' + statuses[key].spend.cost.toFixed(4))), 'its seats table has ' + key + "'s spend this month, as its Seat has it", { row, seat: statuses[key].spend.cost })
    // On a board younger than a day, every run is in the day: its runs and day's spend are the month's (not only the last 20 runs).
    check(Boolean(row && row.startsWith('| ' + key + ' | ' + statuses[key].state + ' | ' + statuses[key].spend.runs + ' | $' + statuses[key].spend.cost.toFixed(4) + ' |')), 'and its runs and spend in the day, all of them', { row, runs: statuses[key].spend.runs })
  }
}

// The operator sequences a hire (design/workbus.md §5.7, §5.8): work that needs a new seat waits on
// the hire's proposal, for the new seat, and no other seat takes it; the handoff that brought it is
// completed, naming what it became; a second request never doubles the proposal; applying it lets the
// new seat do the work; declining it cancels the work, and the operator asks how to proceed. Haiku:
// the operator's turns, the new seat's introduction and its task.
if (pick.has('sequence')) {
  const OP = 'worker:workbus-app+op'
  const since = Date.now() - 1000
  const proposals = async (prefix) => (await board('GET', '/tasks?channel=org/seats&state=all&limit=100')).tasks.map((entry) => entry.message).filter((message) => (message.labels['board.doc.proposal'] ?? '').startsWith('new:org/seats/') && Date.parse(message.createdAt) >= since && (!prefix || message.text.includes(prefix)))
  const openProposals = async () => (await proposals()).filter((message) => ['waiting', 'ready', 'claimed', 'blocked'].includes(message.task.state))
  const opTasks = async () => (await board('GET', '/tasks?state=all&limit=200')).tasks.map((entry) => entry.message).filter((message) => message.by.actor === OP && Date.parse(message.createdAt) >= since)
  // A handoff, as the advisor passes one on.
  const handoff = (await board('POST', '/tasks', { channel: 'ops/plans', text: 'Hand-off: we need a writer (a new seat; no one on the team writes docs) to write a two-line release note for "budgets and pauses" (seats hold a task for the principal at their budget alert and limit, and can be paused and resumed) as a doc in docs/notes. Hire one for it, and give the note to the new writer.', for: OP })).task
  const first = await until(async () => (await openProposals())[0] ?? null, 120000)
  const path = first?.labels['board.doc.proposal'].slice(4)
  const key = path?.split('/').pop()
  const actor = 'worker:workbus-app+' + key
  check(Boolean(first && first.by.actor === OP), 'op proposes the hire', first && { id: first.id, path })
  const waiting = await until(async () => { const { tasks } = await board('GET', '/tasks?needs=' + first.id + '&state=open&limit=50'); return tasks.length ? tasks.map((entry) => entry.message) : null }, 30000)
  check(Boolean(waiting && waiting.every((message) => message.task.state === 'waiting' && message.task.for === actor)), 'the work waits on the proposal, for the new seat', waiting?.map((message) => ({ id: message.id, state: message.task.state, for: message.task.for })))
  const others = (await opTasks()).filter((message) => message.task.for && message.task.for !== actor && !(message.labels['board.doc.proposal']))
  check(others.length === 0, 'and no other seat is given the work meanwhile', others.map((message) => ({ id: message.id, for: message.task.for, text: message.text.slice(0, 60) })))
  const busy = (await opTasks()).filter((message) => /\b(confirm|check|verify|look up)\b/i.test(message.text.split('\n')[0]) && !(message.labels['board.doc.proposal']))
  check(busy.length === 0, 'and no busywork task to check or confirm', busy.map((message) => message.text.slice(0, 80)))
  const closed = await until(async () => { const one = (await board('GET', '/messages/' + handoff.id)).message.task; return one.state === 'completed' ? one : null }, 30000)
  check(Boolean(closed && closed.result.includes('#' + first?.id)), 'the handoff is completed, naming the proposal and the tasks', closed?.result)
  // A second request for the same: no second proposal.
  await board('POST', '/messages', { channel: 'dm/op', text: 'Please propose hiring a writer for the budgets-and-pauses release note (hire_propose), in case it was missed.' })
  await sleep(45000)
  const open = await openProposals()
  check(open.length === 1 && open[0].id === first.id, 'a second request reuses the open proposal: one proposal', open.map((message) => message.id))
  // Applied: the new seat takes up its work.
  const doneAt = Date.now()
  await board('POST', '/tasks/' + first.id + '/complete', {})
  const done = await until(async () => { const { tasks } = await board('GET', '/tasks?needs=' + first.id + '&state=all&limit=50'); const all = tasks.map((entry) => entry.message); return all.length && all.every((message) => message.task.state === 'completed') ? all : null }, 240000, 3000)
  check(Boolean(done), 'applied, the new seat does the work that waited', done?.map((message) => ({ id: message.id, result: message.task.result })))
  const notes = (await board('GET', '/threads?channel=docs/notes&limit=20')).threads.map((one) => one.message).filter((message) => message.doc && message.by.actor === actor)
  check(notes.length >= 1, 'its note is a doc in docs/notes, by it', notes.map((message) => message.doc.path))
  const reported = await until(async () => (await board('GET', '/messages/' + handoff.id)).replies.find((message) => message.by.actor === OP && Date.parse(message.createdAt) >= doneAt), 120000)
  check(Boolean(reported && /^Done: the work this handed off is finished/.test(reported.text) && reported.text.includes('#' + done?.[0]?.id)), "and op says the work is done, in the handoff's thread, once", reported?.text)
  // Declined: a second hire, dropped by the principal.
  await board('POST', '/messages', { channel: 'dm/op', text: 'We need a QA engineer (a new seat) to write a one-page test plan for budgets and pauses as a doc in docs/notes. Hire one for it.' })
  const second = await until(async () => (await openProposals()).find((message) => message.id !== first.id) ?? null, 120000)
  check(Boolean(second), 'a second hire is proposed', second && { id: second.id, path: second.labels['board.doc.proposal'] })
  const waits = second ? (await board('GET', '/tasks?needs=' + second.id + '&state=open&limit=50')).tasks.map((entry) => entry.message.id) : []
  if (second) await board('POST', '/tasks/' + second.id + '/cancel', { reason: 'Not now: no QA hire this month.' })
  const stopped = await until(async () => { if (!waits.length) return true; const states = await Promise.all(waits.map(async (id) => (await board('GET', '/messages/' + id)).message.task.state)); return states.every((state) => state === 'canceled') ? states : null }, 30000)
  check(waits.length > 0 && Boolean(stopped), "declining it cancels the work that waited on it", { waits, stopped })
  const asked = await until(async () => (await status('op')).wakes.find((wake) => wake.id.startsWith('notice:declined:') && wake.thread === second?.id && wake.state === 'done'), 90000)
  const reply = second ? (await board('GET', '/messages/' + second.id)).replies.find((message) => message.by.actor === OP) : null
  check(Boolean(asked && reply), 'and op hears of it once and asks how to proceed', { notice: asked?.id, reply: reply?.text })
}

// Letting a seat go (design/workbus.md §5.7), on the dev stack: a seat made from the engineer template
// (as the owner, so no proposal), with a session (its introduction, one Haiku turn) and a file in its
// workspace, is let go by deleting its seat doc: its wake goes, each session it ran is retired, its
// workspace emptied, and its run records stay; doing it again changes nothing; a seat with a doc
// can't be let go by the route.
if (pick.has('letgo')) {
  const key = 'lg' + Math.random().toString(36).slice(2, 6)
  const template = (await board('GET', '/docs?path=org/templates/engineer')).body
  const body = template.replace(/^# .*$/m, '# Lee').replace(/"role": "engineer",/, '"role": "engineer",\n  "name": "Lee",\n  "handle": "' + key + '",').replace(/\{\{name\}\}/g, 'Lee').replace(/\n## Hiring from this template[\s\S]*$/, '\n')
  const doc = (await board('POST', '/docs', { channel: 'org/seats', slug: key, body })).message
  const introduced = await until(async () => (await seat({ seat: key, call: 'status' })).wakes?.find((wake) => wake.id === 'intro' && wake.state === 'done'), 120000)
  check(Boolean(introduced), 'a seat made from the engineer template is provisioned, and its introduction runs', introduced)
  await fetch(app + '/dev/session', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ seat: key, thread: 'x', call: 'workspace.execute', args: [{ id: 'lg-write', name: 'write', arguments: { path: '/workspace/kept.txt', content: 'hello' } }] }) })
  const files = async () => (await fetch(app + '/dev/session', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ seat: key, thread: 'x', call: 'workspace.files' }) })).json()
  check((await files()).some((file) => file.name === 'kept.txt'), 'its workspace has a file')
  const inspect = async () => (await fetch(app + '/dev/session', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ seat: key, thread: doc.id, call: 'inspect' }) })).json()
  const before = await inspect()
  const runs = (await seat({ seat: key, call: 'status' })).spend?.runs
  check(before.operations?.length >= 1, 'its session (its introduction) has an operation', before.operations?.length)
  // The route refuses a seat with a doc.
  const refused = await fetch(app + '/api/seats/' + key + '/let-go', { method: 'POST' })
  check(refused.status === 409, 'POST /api/seats/<key>/let-go refuses a seat with a seat doc', refused.status)
  await board('POST', '/messages/' + doc.id + '/delete', {})
  const gone = await until(async () => !(await board('GET', '/wakes')).wakes.some((wake) => wake.key === 'seat.' + key), 30000)
  check(gone === true, 'deleting its seat doc removes its wake')
  const status = await until(async () => { const one = await seat({ seat: key, call: 'status' }); return one.retired ? one : null }, 30000)
  check(Boolean(status && status.retired.sessions >= 1 && status.state === 'retired'), 'its Seat is retired and its sessions retired', status?.retired)
  const after = await inspect()
  check((after.operations ?? []).length === 0, 'its session holds nothing now', after.operations)
  check((await files()).length === 0, 'its workspace is empty')
  check(status?.spend?.runs === undefined ? (await seat({ seat: key, call: 'spentSince', args: ['2000-01-01T00:00:00Z'] })).runs === runs : true, 'its run records stay', { runs })
  const again = await (await fetch(app + '/api/seats/' + key + '/let-go', { method: 'POST' })).json()
  check(JSON.stringify(again.retired) === JSON.stringify(status?.retired), 'letting it go again changes nothing', again)
}

console.log(failures ? failures + ' failed' : 'all passed')
process.exitCode = failures ? 1 : 0

// The org on a real bus and app (design/workbus.md §4.4, §4.5, §5.2, §5.5): seeding is idempotent,
// an edit to a seat doc re-reconciles through the reconciler's wake (the seat's wake updates once,
// by revision), a bad edit gets one reply in its thread and changes nothing, a Seat takes a
// delivery once however often it comes, and (with "dm") a DM to @op wakes the operator, which
// makes two tasks for the engineer, the second needing the first, and the engineer wakes.
//   pnpm dev:bus & pnpm dev   (the bus's org set up: node scripts/org-setup.ts <board url> <owner token>)
//   TOKEN=<owner token> node scripts/org-live-check.mjs http://127.0.0.1:8831 http://127.0.0.1:8832 [boot,edit,bad,dedupe,dm,run]
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
  const fence = /(```json#seat@1\n)([\s\S]*?)(\n```)/
  const data = JSON.parse(fence.exec(body)[2])
  change(data)
  const next = body.replace(fence, (_, open, _old, close) => open + JSON.stringify(data, null, 2) + close)
  return (await board('POST', '/docs/' + doc.id + '/edit', { revision: doc.revision, body: next })).doc
}

if (pick.has('boot')) {
  const first = await seat({ call: 'boot' })
  const second = await seat({ call: 'boot' })
  check(second.seeded.length === 0 && second.found.length === 4, 'a second boot seeds nothing and finds the four docs', second.found)
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
  check(one.queued === true && two.queued === false && status.queue.queued === 1, 'a delivery made twice is queued once', { one, two, queue: status.queue })
  check(status.state === 'paused', 'a paused seat starts nothing', status.state)
  const older = await seat({ seat: key, call: 'configure', args: [{ ...paused, sessions: 9 }, 0] })
  check(older.applied === false && (await seat({ seat: key, call: 'status' })).runtime.sessions === paused.sessions, 'an older revision changes nothing', older)
  // A task one of its sessions holds is the principal's: its other events (its ready, in a queue the seat serves) start nothing.
  await seat({ seat: key, call: 'held', args: [{ approvalId: '500', thread: '77', operationId: null }] })
  const ready = await seat({ seat: key, call: 'wake', args: [{ cursor: '424243', type: 'task.ready', message: { id: '500', re: null, channel: 'eng/queue', text: 'asks to run exec', task: { state: 'ready' } } }, context] })
  check(ready.queued === false, "a held task's own events don't wake the seat", ready)
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

console.log(failures ? failures + ' failed' : 'all passed')
process.exitCode = failures ? 1 : 0

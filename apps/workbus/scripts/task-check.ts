// A real run of the task writes (src/data/task-actions.ts) and the inbox's queries (src/inbox/items.ts)
// against a bus: each write shows at once, settles on the board's own event, and rolls back when the
// board refuses it; another person's task writes from wb show up live.
//   WORKBUS_URL=http://127.0.0.1:8872/b/bus WORKBUS_TOKEN=<owner token> OTHER_TOKEN=<another token> node scripts/task-check.ts
import { execFileSync } from 'node:child_process'
import { liveDb, busOf, BusRefusal, type Message } from '../src/data/index.ts'
import { inboxItems } from '../src/inbox/items.ts'
import { isTask, type Task } from '../src/task/model.ts'

const url = process.env.WORKBUS_URL!
const token = process.env.WORKBUS_TOKEN!
const wbPath = new URL('../../../packages/workbus/cli/workbus.mjs', import.meta.url).pathname
const wb = (...args: string[]) => JSON.parse(execFileSync('node', [wbPath, ...args, '--json'], { env: { ...process.env, WORKBUS_URL: url, WORKBUS_TOKEN: process.env.OTHER_TOKEN ?? token }, encoding: 'utf8' }))

let failures = 0
const check = (ok: boolean, what: string, detail: unknown = '') => {
  if (!ok) failures++
  console.log((ok ? 'ok   ' : 'FAIL ') + what + (detail === '' ? '' : '  ' + (typeof detail === 'string' ? detail : JSON.stringify(detail))))
}
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
const outcome = (tx: { when: (state: 'settled') => Promise<unknown> }) => tx.when('settled').then(() => 'persisted', (error: unknown) => error)
const board = async (id: string) => (await bus.runtime.client.get<{ task: Message }>('/tasks?state=all&limit=500').catch(() => null), (await bus.runtime.client.get<{ message: Message }>('/messages/' + id + '?limit=1')).message)

const bus = busOf(liveDb({ url, token }))
await bus.runtime.shared.get('me')
await Promise.all([bus.messages, bus.tasks, bus.actors, bus.threads].map((collection) => collection.preload()))
const me = bus.runtime.me.actor
const w = bus.actions.task
const channel = 'tasks-check'
const task = (id: string) => bus.tasks.get(id) as Task | undefined

// 1. Create: at once, pending, then one row with the board's ID, settled by its client ID.
const text = 'check task ' + Date.now()
const made = w.create({ channel, text })
const pending = [...bus.tasks.values()].find((row) => row.text === text)
check(!!pending?.pending && pending.task?.state === 'ready', 'a new task shows at once, pending and ready', pending?.id)
const t0 = Date.now()
await made.when('settled')
const rows = [...bus.tasks.values()].filter((row) => row.text === text)
const id = rows[0]?.id ?? ''
check(rows.length === 1 && /^\d+$/.test(id) && !rows[0]!.pending && Date.now() - t0 < 5000, 'it settles as one row with the board ID, on its echo', { id, ms: Date.now() - t0 })

// 2. Claim: claimed by me at once; the board agrees, and the token is kept.
const claimTx = w.claim({ id })
check(task(id)?.task.state === 'claimed' && task(id)?.task.claim?.actor === me, 'claim shows at once')
await claimTx.when('settled')
check((await board(id)).task?.state === 'claimed' && !!w.held(id), 'the board has it claimed by me, and this client holds the claim', (await board(id)).task?.claim)

// 3. Release with the kept token, then complete with no claim: complete claims first.
await w.release({ id }).when('settled')
check((await board(id)).task?.state === 'ready', 'release with the kept claim: ready again')
const done = w.complete({ id, result: 'checked' })
check(task(id)?.task.state === 'completed', 'complete shows at once')
const doneWhy = await outcome(done)
check(doneWhy === 'persisted', 'the board takes the completion', doneWhy instanceof Error ? doneWhy.message : '')
const after = await board(id)
check(after.task?.state === 'completed' && after.task?.result === 'checked' && task(id)?.task.state === 'completed', 'complete without a claim claims, then completes', after.task)

// 3b. Claim, then complete with that claim (not a second claim, which the board refuses).
const third = w.create({ channel, text: 'claim then complete ' + Date.now(), id: 'cc-' + Date.now() })
await third.when('settled')
const id3 = [...bus.tasks.values()].filter((row) => row.text.startsWith('claim then complete ') && !row.pending).sort((a, b) => Number(b.id) - Number(a.id))[0]!.id
await w.claim({ id: id3 }).when('settled')
const ccWhy = await outcome(w.complete({ id: id3 }))
check(ccWhy === 'persisted' && (await board(id3)).task?.state === 'completed', 'claim, then complete: it completes with the claim it holds', ccWhy instanceof Error ? ccWhy.message : (await board(id3)).task?.state)

// 4. Hold with a kind, then unblock: held for me, then ready.
const second = w.create({ channel, text: 'to hold ' + Date.now(), id: 'check-' + Date.now() })
await second.when('settled')
const id2 = [...bus.tasks.values()].find((row) => row.text.startsWith('to hold ') && !row.pending && row.task?.state === 'ready')!.id
await w.block({ id: id2, reason: 'pick one', kind: 'decision' }).when('settled')
check((await board(id2)).task?.state === 'blocked' && ((await board(id2)).task?.blocked as { kind: string })?.kind === 'decision', 'hold with a kind: the board has it held, as a decision')
const items = () => inboxItems({ reach: { ready: true, channels: new Map(), threads: new Map(), reached: [], cursor: 0 }, tasks: [...bus.tasks.values()].filter(isTask) as Task[], messages: new Map(), me, can: bus.runtime.me.can })
check(items().some((item) => item.thread === id2 && item.reasons.some((reason) => reason.kind === 'held' && reason.hold === 'decision')), 'and it is in the inbox, held, with its kind')
await w.unblock({ id: id2 }).when('settled')
check((await board(id2)).task?.state === 'ready' && !items().some((item) => item.thread === id2), 'unblock: ready, and out of the inbox')

// 5. A refused write rolls back: assign to someone who isn't the owner's profile.
const refused = w.assign({ id: id2, for: 'workbus:user:nobody' })
check(task(id2)?.task.for === 'workbus:user:nobody', 'a refused assign shows at once too')
const why = await outcome(refused)
check(why instanceof BusRefusal && task(id2)?.task.for === null, 'the board refuses it, and it rolls back', { why: why instanceof Error ? why.message : String(why), for: task(id2)?.task.for })
await w.assign({ id: id2, for: me + '+op' }).when('settled')
check((await board(id2)).task?.for === me + '+op', "assign to one of the owner's profiles")

// 6. Another person's task writes show up live: a task from wb, held by them as an approval.
const theirs = wb('tasks', 'create', channel, 'theirs ' + Date.now()).task as Message
const sent = Date.now()
wb('tasks', 'block', theirs.id, 'needs your OK', '--kind', 'approval')
const live = await until(bus.tasks, () => task(theirs.id)?.task.state === 'blocked')
check(live >= 0 && items().some((item) => item.thread === theirs.id && item.reasons.some((reason) => reason.kind === 'held' && reason.hold === 'approval')), "someone else's held task shows up live, in the inbox as an approval", { ms: Date.now() - sent })

// 7. A proposal (someone without edit asks): in the inbox, and applying it edits the doc.
const slug = 'check-' + Date.now()
wb('doc', 'create', channel + '/' + slug, '# Check\n\n## Plan\n\nOne.\n')
const proposed = wb('doc', 'edit', channel + '/' + slug, '--section', 'check/plan', 'Two.', '--propose')
const pid = String(proposed.proposal?.id ?? proposed.task?.id ?? '')
await until(bus.tasks, () => !!task(pid)?.labels['board.doc.proposal'])
check(items().some((item) => item.thread === pid && item.reasons.some((reason) => reason.kind === 'proposal')), 'a proposal is in the inbox', pid)
await w.complete({ id: pid }).when('settled')
const doc = await bus.runtime.client.get<{ body: string }>('/docs?path=' + encodeURIComponent(channel + '/' + slug)).catch(() => null)
check((await board(pid)).task?.state === 'completed' && !items().some((item) => item.thread === pid), 'applying it completes it, and it leaves the inbox')
check(!!doc?.body.includes('Two.'), 'and the doc has the change', doc?.body)

// 8. Cancel (the owner's), with a reason.
await w.cancel({ id: id2, reason: 'not needed' }).when('settled')
check((await board(id2)).task?.state === 'canceled', 'cancel with a reason')

if (failures) {
  console.log(failures + ' failed')
  process.exit(1)
}
console.log('all passed')
process.exit(0)

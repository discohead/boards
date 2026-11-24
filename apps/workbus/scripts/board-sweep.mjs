// The board clean-up (#26): an inventory of a live board, each thing classified KEEP, DELETE,
// ARCHIVE (a channel), HIDE (an actor), or REVIEW (unsure: never deleted), by the reviewed rules
// below; and, once moderation (#26), archiving (#15), and hiding (#16) are live, applying exactly
// a reviewed plan, nothing else.
//
//   WORKBUS_ACCESS_TOKEN=$(cloudflared access token -app=https://workbus.dev) \
//     node apps/workbus/scripts/board-sweep.mjs --plan [--out plan.json] [--board https://workbus.dev/b/bus]
//   WORKBUS_ACCESS_TOKEN=… node apps/workbus/scripts/board-sweep.mjs --apply plan.json --canary <id> [--canary-only] [--canary-wait 30]
//     [--settle 20] [--pause] [--app <app origin>] [--board …]
//
// The owner is the caller (the Access token, sent as cf-access-token; never printed). A local board
// takes WORKBUS_OWNER_TOKEN instead (a bearer token). --plan only reads. --apply reads each item
// again before acting and skips any that changed since the plan (a new reply, a new author).
// Seats' run records live in each Seat and in Basin, not on the board: nothing here touches them.
import { readFileSync, writeFileSync } from 'node:fs'
import { parseArgs } from 'node:util'
import { ROUTES } from './check/cleanup.mjs'

const { values } = parseArgs({ options: { plan: { type: 'boolean' }, apply: { type: 'string' }, out: { type: 'string', default: 'board-sweep-plan.json' }, board: { type: 'string', default: 'https://workbus.dev/b/bus' }, app: { type: 'string' }, pause: { type: 'boolean' }, settle: { type: 'string', default: '20' }, canary: { type: 'string' }, 'no-canary': { type: 'boolean' }, 'canary-only': { type: 'boolean' }, 'canary-wait': { type: 'string', default: '30' } } })
if (!values.plan && !values.apply) throw new Error('usage: board-sweep.mjs --plan [--out plan.json] | --apply plan.json  [--board <board url>]')
const board = values.board.replace(/\/+$/, '')
const access = process.env.WORKBUS_ACCESS_TOKEN
const bearer = process.env.WORKBUS_OWNER_TOKEN
if (!access && !bearer) throw new Error('set WORKBUS_ACCESS_TOKEN (live, through Access) or WORKBUS_OWNER_TOKEN (a local board)')
const headers = access ? { 'cf-access-token': access } : { authorization: 'Bearer ' + bearer }

async function call(method, path, body) {
  const response = await fetch(board + path, { method, headers: { ...headers, ...(body !== undefined ? { 'content-type': 'application/json' } : {}) }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) })
  const text = await response.text()
  if (!response.ok) throw new Error(method + ' ' + path + ' answered ' + response.status + ': ' + text.slice(0, 300))
  return text ? JSON.parse(text) : null
}
const get = (path) => call('GET', path)

// -- the reviewed rules ------------------------------------------------------------------------
// KEEP: the real seats' org docs (op, advisor, ada), org/structure, org/teams/*, org/templates/*,
// the seats, and the app. CLEAR: everything the checks and test runs made, and the principal's
// first attempt (the npm date-libraries plan). LET GO: Dana (@docs). Unsure goes to REVIEW.

const SEATS = ['op', 'advisor', 'ada']
const LET_GO = ['docs']

/** Channels made only by checks or test runs: archived once emptied. */
const TEST_CHANNEL = (path) => path.startsWith('checks/') || ['dm/hmwtkq7', 'dm/owner-check', 'dm/rel', 'ops/checks'].includes(path)
/** Channels the app or a team uses: their test threads go, the channel stays. */
const SYSTEM_CHANNEL = ['dm/op', 'dm/ada', 'dm/advisor', 'eng', 'eng/queue', 'ops/briefs', 'ops/consults', 'ops/plans', 'docs/plans', 'org', 'org/seats', 'org/teams', 'org/templates']
/** The principal's first attempt: the npm date-libraries plan. */
const FIRST_ATTEMPT = /npm date[- ]lib|npm-date-libs|date libraries/i

function threadRule(t) {
  const doc = t.doc?.path
  if (doc === 'org/structure' || /^org\/(teams|templates)\//.test(doc ?? '')) return ['KEEP', 'org doc: ' + doc]
  if (doc && SEATS.some((s) => doc === 'org/seats/' + s)) return ['KEEP', 'a real seat\'s doc']
  if (doc && LET_GO.some((s) => doc === 'org/seats/' + s)) return ['DELETE', 'Dana (@docs) is let go: deleting her seat doc retires her Seat (org/reconcile.ts); her run records stay']
  if (FIRST_ATTEMPT.test(t.text) || t.id === '1415') return ['DELETE', "the principal's first attempt (npm date libraries)"]
  if (t.channel === 'org/teams' && t.task) return ['DELETE', 'a proposal to change org/teams/eng from a test run']
  if (t.channel === 'org/seats' && t.task) return ['DELETE', 'a hiring proposal from a test run (' + (t.task.state ?? '') + ')']
  if (t.channel === 'org' && !t.doc) return ['DELETE', 'a test hire\'s introduction']
  if (t.channel.startsWith('org')) return ['REVIEW', 'in org/, not matched by a keep or clear rule']
  if (t.channel.startsWith('dm/') && /^Hi, I'm /.test(t.text)) return ['DELETE', 'a test hire\'s introduction in its DM']
  if (TEST_CHANNEL(t.channel)) return ['DELETE', 'made by a check or test run']
  if (SYSTEM_CHANNEL.includes(t.channel) || t.channel.startsWith('docs/')) return ['DELETE', 'a test thread, task, brief, or doc in ' + t.channel]
  return ['REVIEW', 'in a channel the rules don\'t name']
}

function channelRule(c, liveAfter) {
  if (TEST_CHANNEL(c.path)) return ['ARCHIVE', 'made only by checks or test runs']
  if (c.path === 'dm/docs') return ['ARCHIVE', 'Dana (@docs) is let go: her DM']
  if (c.path === 'docs/notes') return ['KEEP', 'kept empty: the writer template may post under docs/ (approved)']
  if (SYSTEM_CHANNEL.includes(c.path)) return ['KEEP', liveAfter + ' threads stay; the app or a team uses it']
  return ['REVIEW', 'a channel the rules don\'t name']
}

function actorRule(a) {
  if (a.kind === 'deployment') return ['KEEP', 'the app']
  if (a.kind === 'person' && a.id.startsWith('access:user:') && !a.id.includes('+')) return ['KEEP', 'the principal (owner)']
  const seat = a.id.startsWith('worker:workbus-app+') ? a.id.slice('worker:workbus-app+'.length) : null
  if (seat && SEATS.includes(seat)) return ['KEEP', 'a real seat']
  if (seat && LET_GO.includes(seat)) return ['HIDE', 'Dana (@docs) is let go']
  if (seat) return ['HIDE', 'a test hire (' + a.handle + ')']
  if (a.id.includes('+')) return ['HIDE', 'a profile a check made (' + a.handle + ')']
  if (a.id === 'workbus:user:checker') return ['HIDE', 'the checks\' second actor']
  return ['REVIEW', 'an actor the rules don\'t name']
}

// -- the inventory ------------------------------------------------------------------------------

async function inventory() {
  const channels = []
  for (let after = ''; ; ) {
    const page = await get('/channels' + (after ? '?after=' + encodeURIComponent(after) : ''))
    channels.push(...page.channels)
    if (!page.next || page.channels.length === 0) break
    after = page.next
  }
  const threads = []
  for (const c of channels) {
    for (let before = null; ; ) {
      const page = await get('/threads?channel=' + encodeURIComponent(c.path) + '&limit=500' + (before ? '&before=' + encodeURIComponent(before) : ''))
      for (const t of page.threads) if (!t.message.deleted) threads.push({ ...t.message, replies: t.replies })
      if (!page.older || page.threads.length === 0) break
      before = page.older
    }
  }
  const actors = (await get('/actors')).actors
  return { channels, threads, actors }
}

const handleOf = (actors, id) => actors.find((a) => a.id === id)?.handle ?? id
const firstLine = (actors, text) => (text.split('\n').find((line) => line.trim()) ?? '').replace(/^#+\s*/, '').replace(/@\[([^\]\s]+)\]/g, (_, id) => '@' + handleOf(actors, id)).slice(0, 100)

async function plan() {
  const { channels, threads, actors } = await inventory()
  const items = []
  for (const t of threads) {
    const [action, reason] = threadRule(t)
    items.push({ kind: 'thread', id: t.id, channel: t.channel, author: handleOf(actors, t.by.actor), at: t.createdAt, first: firstLine(actors, t.text), task: t.task?.state ?? null, doc: t.doc?.path ?? null, replies: t.replies, version: t.version, action, reason })
  }
  for (const c of channels) {
    const live = threads.filter((t) => t.channel === c.path)
    const staying = live.filter((t) => ['KEEP', 'REVIEW'].includes(items.find((i) => i.kind === 'thread' && i.id === t.id).action)).length
    const [action, reason] = channelRule(c, staying)
    items.push({ kind: 'channel', path: c.path, live: live.length, listed: c.threads, action, reason })
  }
  for (const a of actors) {
    const [action, reason] = actorRule(a)
    items.push({ kind: 'actor', id: a.id, handle: a.handle, actorKind: a.kind, action, reason })
  }
  const out = { board, at: new Date().toISOString(), items }
  writeFileSync(values.out, JSON.stringify(out, null, 2) + '\n')
  const show = (i) => (i.kind === 'thread' ? '#' + i.id + ' ' + i.channel + ' ' + i.author + ' ' + i.at.slice(0, 16) + (i.task ? ' [task ' + i.task + ']' : '') + (i.doc ? ' [doc ' + i.doc + ']' : '') + ' ' + i.first : i.kind === 'channel' ? i.path + ' (' + i.live + ' live, ' + i.listed + ' listed)' : i.handle + ' ' + i.id.replace(/(access:user:)[0-9a-f-]{8,}/, '$1<sub>')) + '  · ' + i.reason
  for (const action of ['KEEP', 'DELETE', 'ARCHIVE', 'HIDE', 'REVIEW']) {
    const group = items.filter((i) => i.action === action)
    console.log('\n' + action + ' (' + group.length + ')')
    for (const i of group) console.log('  ' + i.kind.padEnd(7) + ' ' + show(i))
  }
  console.log('\nwritten to ' + values.out)
}

// -- applying a reviewed plan ------------------------------------------------------------------
//
// Safeguards: the sweep must wake no seat and cost nothing, and the watchdog must post nothing.
// - Every delete is moderation (#26), the caller's own messages too ({ moderation: true }, #42): a root
//   takes its replies in one write, and its message.deleted says moderation: true, which wakes no wake
//   and no watcher. A delete the board answers without a count was a plain one: the sweep stops there.
// - The channels to archive are archived first: nothing in an archived channel wakes anyone. A DM is
//   archived by its own path (a subtree never reaches a private channel).
// - A canary goes first (--canary <id>, a DELETE thread with replies): its message.deleted must say
//   moderation: true, its replies must be gone, and after --canary-wait seconds no Seat may have
//   moved. Only then the rest.
// - Each kept seat's Seat is read before (GET <app>/api/seats/<key>: its runs and its wakes, of any
//   state), after every 10 actions, and at the end; if either moved, it stops there.
// - --pause pauses the seats for the sweep (their seat docs' state), and puts them back only if
//   nothing moved. It's off by default: moderation wakes no one, and a pause is itself a doc edit.
// - After a settle (--settle, seconds), the board's events since the start must hold no post by the
//   app or a seat (a watchdog note, a seat's reply).
// - Everything done, skipped, or already gone is logged, id by id, to <plan>.applied-<time>.json.

// The routes the clean-up needs, by name in the board's OpenAPI: delete (any message, as the
// owner, #26), archive a channel (#15), and hide an actor (#16).
const NEEDS = { delete: 'delete', archive: ROUTES.archive, hide: ROUTES.hide }
const APP = 'worker:workbus-app'
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/** A Seat's runs and wakes (all states), through the app. */
async function seatCount(app, key) {
  const response = await fetch(app + '/api/seats/' + key, { headers })
  if (!response.ok) throw new Error('GET /api/seats/' + key + ' answered ' + response.status)
  const status = await response.json()
  return { runs: status.spend?.runs ?? 0, wakes: Object.values(status.queue ?? {}).reduce((sum, n) => sum + Number(n), 0), state: status.state ?? null, code: status.code ?? null }
}

/** A seat doc's json#seat block, its state set: the body, or null when it has no such block. */
function withState(body, state) {
  const block = /(\x60\x60\x60json#seat@\d+\n)([\s\S]*?)(\n\x60\x60\x60)/.exec(body)
  if (!block) return null
  const seat = JSON.parse(block[2])
  const was = seat.state ?? 'active'
  seat.state = state
  return { was, body: body.slice(0, block.index) + block[1] + JSON.stringify(seat, null, 2) + block[3] + body.slice(block.index + block[0].length) }
}

async function setState(key, state) {
  const read = await get('/docs?path=' + encodeURIComponent('org/seats/' + key))
  const next = withState(read.body, state)
  if (!next) throw new Error('org/seats/' + key + ' has no json#seat block')
  if (next.was !== state) await call('POST', '/docs/' + read.doc.id + '/edit', { revision: read.doc.revision, body: next.body })
  return next.was
}

/** The board's events after a cursor, every page. */
async function eventsAfter(cursor) {
  const out = []
  for (let after = cursor; ; ) {
    const page = await get('/events?after=' + after)
    out.push(...page.events)
    if (!page.events.length || page.cursor === after) return out
    after = page.cursor
  }
}

async function apply(path) {
  const reviewed = JSON.parse(readFileSync(path, 'utf8'))
  if (reviewed.board !== board) throw new Error('the plan is for ' + reviewed.board + ', not ' + board)
  const app = (values.app ?? new URL(board).origin).replace(/\/+$/, '')
  const spec = await get('/openapi.json')
  const ops = new Map(Object.entries(spec.paths).flatMap(([route, methods]) => Object.values(methods).map((op) => [op.operationId, { route, op }])))
  const missing = Object.values(NEEDS).filter((name) => !ops.has(name))
  if (missing.length) throw new Error('the board has no ' + missing.join(', ') + ' yet: apply waits for #26, #15, and #16 to be live')
  const me = (await get('/me')).actor

  const items = reviewed.items
  const threads = items.filter((i) => i.kind === 'thread' && i.action === 'DELETE')
  const canary = values.canary ? threads.find((i) => i.id === String(values.canary).replace(/^#/, '')) : null
  if (values.canary && !canary) throw new Error('the canary #' + values.canary + ' is no DELETE thread in the plan')
  if (canary && !(canary.replies > 0)) throw new Error('the canary #' + canary.id + ' has no replies: pick one with replies')
  if (!canary && !values['no-canary']) throw new Error('--canary <id> (a DELETE thread with replies) goes first; --no-canary to go without one')

  const seats = items.filter((i) => i.kind === 'actor' && i.action === 'KEEP' && i.id.startsWith(APP + '+')).map((i) => i.id.slice(APP.length + 1))
  const log = { plan: path, board, app, me, started: new Date().toISOString(), seats: { before: {}, after: {} }, paused: {}, canary: null, archived: [], deleted: [], hidden: [], gone: [], skipped: [], stopped: null, appPosts: [] }
  const logPath = path.replace(/\.json$/, '') + '.applied-' + log.started.replace(/[:.]/g, '-') + '.json'
  const save = () => writeFileSync(logPath, JSON.stringify(log, null, 2) + '\n')
  const moved = async () => {
    for (const key of seats) {
      const now = await seatCount(app, key)
      const was = log.seats.before[key]
      if (now.runs !== was.runs || now.wakes !== was.wakes) return key + ': runs ' + was.runs + ' → ' + now.runs + ', wakes ' + was.wakes + ' → ' + now.wakes
    }
    return null
  }
  const stop = (why) => Object.assign(new Error(why), { stop: true })
  const cursor = (await get('/events?last=1')).cursor
  if (values.pause) for (const key of seats) log.paused[key] = await setState(key, 'paused')
  for (const key of seats) log.seats.before[key] = await seatCount(app, key)
  save()

  let actions = 0
  const watch = async () => {
    save()
    if (++actions % 10) return
    const why = await moved()
    if (why) throw stop('a seat moved: ' + why)
  }
  /** One thread, by moderation: its root, which takes its replies (more than the board takes in one write: the replies first). */
  const remove = async (item) => {
    const now = await get('/messages/' + item.id + '?limit=500').catch(() => null)
    if (!now || now.message.deleted) return log.gone.push('#' + item.id), null
    if (now.message.id !== item.id || now.message.channel !== item.channel || now.message.version !== item.version || now.replies.filter((r) => !r.deleted).length !== item.replies) {
      log.skipped.push({ id: '#' + item.id, why: 'changed since the plan' })
      return null
    }
    // Every delete asks for moderation (#26, #42: the caller's own messages too). The board answers a
    // moderation delete with how many it deleted; a plain delete (no count) would wake the seats in
    // its channel, so the sweep stops on one.
    const body = { moderation: true }
    let answer = await call('POST', '/messages/' + item.id + '/delete', body).catch((error) => error)
    if (answer instanceof Error && /413|thread_too_large/.test(answer.message)) {
      for (const reply of now.replies.filter((r) => !r.deleted).reverse()) await call('POST', '/messages/' + reply.id + '/delete', body)
      answer = await call('POST', '/messages/' + item.id + '/delete', body)
    }
    if (answer instanceof Error) throw answer
    if (typeof answer?.deleted !== 'number') throw stop('#' + item.id + ': the board took a plain delete (no count in ' + JSON.stringify(answer) + '), not moderation')
    log.deleted.push({ id: '#' + item.id, channel: item.channel, messages: answer.deleted ?? null })
    return answer
  }

  try {
    // The canary: one thread with replies, then its event, its replies, and every Seat, after a wait.
    if (canary) {
      const at = (await get('/events?last=1')).cursor
      const answer = await remove(canary)
      if (!answer) throw stop('the canary #' + canary.id + ' was not deleted: ' + JSON.stringify(log.skipped.at(-1) ?? log.gone.at(-1)))
      const events = (await eventsAfter(at)).filter((e) => e.type === 'message.deleted')
      const root = events.find((e) => String(e.payload?.id ?? e.message?.id) === canary.id)
      const plain = events.filter((e) => e.payload?.moderation !== true).map((e) => '#' + (e.payload?.id ?? e.message?.id))
      const after = await get('/messages/' + canary.id + '?limit=500').catch(() => null)
      const left = after ? after.replies.filter((r) => !r.deleted).map((r) => '#' + r.id) : []
      await sleep(Number(values['canary-wait']) * 1000)
      const why = await moved()
      log.canary = { id: '#' + canary.id, channel: canary.channel, deleted: answer.deleted, moderation: root?.payload?.moderation ?? null, plain, events: events.length, repliesLeft: left, rootDeleted: after ? Boolean(after.message.deleted) : true, moved: why }
      save()
      console.log('canary ' + JSON.stringify(log.canary))
      if (!root || root.payload?.moderation !== true || plain.length) throw stop('the canary: ' + (root ? 'deletes without moderation: true: ' + (plain.join(', ') || '#' + canary.id) : 'no message.deleted for #' + canary.id))
      if (left.length || !log.canary.rootDeleted) throw stop('the canary: ' + (left.length ? 'replies left ' + left.join(', ') : 'its root is still there'))
      if (why) throw stop('the canary: a seat moved: ' + why)
      if (values['canary-only']) throw stop('--canary-only: stopped after the canary, as asked')
    }
    // Archive first: nothing in an archived channel wakes anyone, and deletes there still work.
    const channels = new Set((await get('/channels?archived=true')).channels.filter((c) => !c.archived).map((c) => c.path))
    for (const item of items.filter((i) => i.kind === 'channel' && i.action === 'ARCHIVE')) {
      if (!channels.has(item.path)) {
        log.gone.push(item.path)
        continue
      }
      await call('POST', ops.get(NEEDS.archive).route, { path: item.path })
      log.archived.push(item.path)
      await watch()
    }
    for (const item of threads.filter((i) => i !== canary)) {
      if (await remove(item)) await watch()
    }
    const actors = new Set((await get('/actors')).actors.map((a) => a.id))
    for (const item of items.filter((i) => i.kind === 'actor' && i.action === 'HIDE')) {
      if (!actors.has(item.id)) {
        log.gone.push(item.id)
        continue
      }
      await call('POST', ops.get(NEEDS.hide).route, { actor: item.id, hidden: true })
      log.hidden.push(item.id)
      await watch()
    }
    await sleep(Number(values.settle) * 1000)
    const why = await moved()
    if (why) throw stop('a seat moved: ' + why)
    // Nothing the app or a seat posted since the start: no watchdog note, no seat's reply.
    for (const event of await eventsAfter(cursor)) if (event.type === 'message.posted' && String(event.message?.by?.actor ?? '').startsWith(APP)) log.appPosts.push({ id: event.message.id, by: event.message.by.actor, text: String(event.message.text).slice(0, 120) })
    if (log.appPosts.length) throw stop('the app or a seat posted during the sweep: ' + log.appPosts.map((p) => '#' + p.id).join(', '))
  } catch (error) {
    log.stopped = error.message
  } finally {
    for (const key of seats) log.seats.after[key] = await seatCount(app, key).catch((error) => ({ error: error.message }))
    // Put the seats back as they were, only if nothing moved: else they stay paused for a look.
    if (!log.stopped) for (const [key, was] of Object.entries(log.paused)) if (was !== 'paused') await setState(key, was)
    log.ended = new Date().toISOString()
    save()
  }
  console.log((log.stopped ? 'STOPPED: ' + log.stopped + (Object.keys(log.paused).length ? ' (the seats stay paused)' : '') + '\n' : '') + 'deleted ' + log.deleted.length + ' threads (' + log.deleted.reduce((n, d) => n + (d.messages ?? 0), 0) + ' messages), archived ' + log.archived.length + ', hidden ' + log.hidden.length + ', already gone ' + log.gone.length + ', skipped ' + log.skipped.length + '\nseats before ' + JSON.stringify(log.seats.before) + '\nseats after  ' + JSON.stringify(log.seats.after) + '\nlog: ' + logPath)
  if (log.stopped) process.exitCode = 1
}

if (values.plan) await plan()
else await apply(values.apply)

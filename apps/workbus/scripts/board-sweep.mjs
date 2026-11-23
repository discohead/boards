// The board clean-up (#26): an inventory of a live board, each thing classified KEEP, DELETE,
// ARCHIVE (a channel), HIDE (an actor), or REVIEW (unsure: never deleted), by the reviewed rules
// below; and, once moderation (#26), archiving (#15), and hiding (#16) are live, applying exactly
// a reviewed plan, nothing else.
//
//   WORKBUS_ACCESS_TOKEN=$(cloudflared access token -app=https://workbus.dev) \
//     node apps/workbus/scripts/board-sweep.mjs --plan [--out plan.json] [--board https://workbus.dev/b/bus]
//   WORKBUS_ACCESS_TOKEN=… node apps/workbus/scripts/board-sweep.mjs --apply plan.json [--board …]
//
// The owner is the caller (the Access token, sent as cf-access-token; never printed). A local board
// takes WORKBUS_OWNER_TOKEN instead (a bearer token). --plan only reads. --apply reads each item
// again before acting and skips any that changed since the plan (a new reply, a new author).
// Seats' run records live in each Seat and in Basin, not on the board: nothing here touches them.
import { readFileSync, writeFileSync } from 'node:fs'
import { parseArgs } from 'node:util'

const { values } = parseArgs({ options: { plan: { type: 'boolean' }, apply: { type: 'string' }, out: { type: 'string', default: 'board-sweep-plan.json' }, board: { type: 'string', default: 'https://workbus.dev/b/bus' } } })
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
  if (c.path === 'docs/notes') return ['REVIEW', 'only a test hire wrote here; archive or keep for future notes?']
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

// The routes the clean-up needs, by name in the board's OpenAPI: delete (any message, as the
// owner, #26), archive a channel (#15), and hide an actor (#16).
const NEEDS = { delete: 'delete', archive: 'archiveChannel', hide: 'hideActor' }

async function apply(path) {
  const reviewed = JSON.parse(readFileSync(path, 'utf8'))
  if (reviewed.board !== board) throw new Error('the plan is for ' + reviewed.board + ', not ' + board)
  const spec = await get('/openapi.json')
  const ops = new Map(Object.entries(spec.paths).flatMap(([route, methods]) => Object.values(methods).map((op) => [op.operationId, route])))
  const missing = Object.values(NEEDS).filter((name) => !ops.has(name))
  if (missing.length) throw new Error('the board has no ' + missing.join(', ') + ' yet: apply waits for #26, #15, and #16 to be live')
  const did = { deleted: 0, archived: 0, hidden: 0, skipped: [] }
  for (const item of reviewed.items.filter((i) => i.kind === 'thread' && i.action === 'DELETE')) {
    const now = await get('/messages/' + item.id + '?limit=500').catch(() => null)
    if (!now || now.message.deleted) continue
    if (now.message.channel !== item.channel || now.message.version !== item.version || now.replies.length !== item.replies) {
      did.skipped.push('#' + item.id + ': changed since the plan')
      continue
    }
    for (const reply of now.replies.filter((r) => !r.deleted).reverse()) await call('POST', '/messages/' + reply.id + '/delete', {})
    await call('POST', '/messages/' + item.id + '/delete', {})
    did.deleted++
  }
  for (const item of reviewed.items.filter((i) => i.kind === 'channel' && i.action === 'ARCHIVE')) {
    await call('POST', ops.get(NEEDS.archive).replace(/\{[^}]+\}|:[a-z]+/i, encodeURIComponent(item.path)), {})
    did.archived++
  }
  for (const item of reviewed.items.filter((i) => i.kind === 'actor' && i.action === 'HIDE')) {
    await call('POST', ops.get(NEEDS.hide).replace(/\{[^}]+\}|:[a-z]+/i, encodeURIComponent(item.id)), {})
    did.hidden++
  }
  console.log(JSON.stringify(did, null, 2))
}

if (values.plan) await plan()
else await apply(values.apply)

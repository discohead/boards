// Differential check of archival: the same requests against two boards, one that never archives and
// one archived as far as it goes (every event sealed, every idle thread cold) before each request.
// Every answer must be the same on both, but for what differs by nature: times, the UUIDs a board
// makes for thread keys, file IDs, and claim tokens.
//
//   node scripts/archive-check.mjs [origin]      (a Worker on wrangler dev, at http://127.0.0.1:8811)
//
// Exits 1 when any answer differs, printing each.
import { execFileSync } from 'node:child_process'
import { isDeepStrictEqual } from 'node:util'

const origin = (process.argv[2] ?? 'http://127.0.0.1:8811').replace(/\/+$/, '')
const run = Date.now().toString(36)
const names = { plain: 'chk-plain-' + run, archived: 'chk-arch-' + run }
const tokens = new Map()
const token = (sub, url) => {
  const key = sub + ' ' + url
  if (!tokens.has(key)) tokens.set(key, execFileSync('node', ['scripts/issuer.mjs', 'token', sub, url], { encoding: 'utf8' }).trim())
  return tokens.get(key)
}

function client(board) {
  const url = origin + '/b/' + board
  const files = new Map()
  const call = async (method, path, body, { as = 'jared', headers = {}, raw } = {}) => {
    const response = await fetch(url + path, {
      method,
      headers: { authorization: 'Bearer ' + token(as, url), ...(raw ? {} : { 'content-type': 'application/json' }), ...headers },
      body: raw ?? (body === undefined ? undefined : JSON.stringify(body)),
    })
    const text = await response.text()
    let json
    try { json = JSON.parse(text) } catch { json = text }
    return { status: response.status, json }
  }
  return { board, url, call, files }
}
const plain = client(names.plain)
const archived = client(names.archived)

const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
/** An answer with what differs by nature named, not compared. */
function normalize(value, side) {
  const uuids = new Map()
  const walk = (v, key) => {
    if (typeof v === 'string') {
      if (key === 'token' || key === 'lease') return '<' + key + '>'
      if (ISO.test(v)) return '<time>'
      if (side.files.has(v)) return side.files.get(v)
      if (UUID.test(v)) {
        if (!uuids.has(v)) uuids.set(v, '<uuid' + uuids.size + '>')
        return uuids.get(v)
      }
      return v
    }
    if (Array.isArray(v)) return v.map((item) => walk(item))
    if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, item]) => [k, walk(item, k)]))
    return v
  }
  return walk(value)
}

let archiveRuns = 0
async function archiveAll(forget = archiveRuns++ % 2 === 0) {
  const started = Date.now()
  // Archive as far as it goes, on any deployment: every event sealed, every idle thread cold.
  // Every other time, what the board read back stays in memory: reads from it must be as fresh.
  const asked = await archived.call('POST', '/archive', { sealAfterMs: 0, coldAfterMs: 0, freezeAfterMs: 0, pageThreads: 4, segment: 16, keep: 1, everyMs: 50, run: true, forget })
  if (asked.status !== 200) throw new Error('archive run: ' + JSON.stringify(asked.json))
  // Up to two minutes: against R2 across a network, a step that cools a hundred threads takes seconds.
  while (Date.now() - started < 120_000) {
    const { json } = await archived.call('GET', '/archive')
    if (json.last && json.last.at >= started && !json.last.more) return json
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
  throw new Error('archival did not settle')
}

let compared = 0
const timings = []
let coldReads = 0
const differences = []
/** One request on both boards (the archived one archived first); the answers must match. */
async function both(label, request, forget) {
  const a = await request(plain)
  const status = await archiveAll(forget)
  if (status.cold.threads + status.frozen.threads > 0) coldReads++
  const started = performance.now()
  const b = await request(archived)
  const ms = performance.now() - started
  timings.push({ label, ms })
  if (process.env.CHECK_PROGRESS) process.stderr.write(label + '  ' + ms.toFixed(0) + ' ms  ' + (b?.status ?? (Array.isArray(b) ? b.map((page) => page.status).join(',') : '')) + '\n')
  compared++
  const na = normalize(a, plain)
  const nb = normalize(b, archived)
  if (!isDeepStrictEqual(na, nb)) differences.push({ label, plain: na, archived: nb })
  return [a, b]
}
const same = (label, method, path, body, options) => both(label, (side) => side.call(method, path, body, options))
/** The same, but what the archived board read back stays in memory. */
const sameKept = (label, method, path, body, options) => both(label, (side) => side.call(method, path, body, options), false)

/** A listing that must answer the same reading no archived thread on the archived board: only frozen pages, if any. */
const pageReads = []
async function sqliteOnly(label, path) {
  const before = (await archived.call('GET', '/archive')).json
  await same(label, 'GET', path)
  const after = (await archived.call('GET', '/archive')).json
  const loaded = { restored: after.loads.restored - before.loads.restored, read: after.loads.read - before.loads.read }
  pageReads.push({ label, pages: after.loads.pages - before.loads.pages })
  if (after.cold.threads + after.frozen.threads > 0 && (loaded.restored || loaded.read)) differences.push({ label: label + ' (read R2)', plain: { restored: 0, read: 0 }, archived: loaded })
}

/** Eight of the same read at once on the archived board, while its archival keeps running. */
async function concurrently(label, path) {
  const expected = normalize(await plain.call('GET', path), plain)
  await archiveAll()
  const answers = await Promise.all(Array.from({ length: 8 }, () => archived.call('GET', path)))
  compared++
  for (const [i, answer] of answers.entries()) {
    const got = normalize(answer, archived)
    if (!isDeepStrictEqual(expected, got)) differences.push({ label: label + ' #' + i, plain: expected, archived: got })
  }
}

// -- setup --------------------------------------------------------------------------------------
await plain.call('POST', '/archive', { enabled: false })
await archived.call('POST', '/archive', { enabled: true, sealAfterMs: 0, coldAfterMs: 0, freezeAfterMs: 0, pageThreads: 4, segment: 16, keep: 1, everyMs: 3_600_000, stepThreads: 1000 })

// -- history: roots, replies, reactions, edits, deletes, labels, a file, tasks -------------------
const CHANNELS = ['general', 'eng/backend', 'eng/frontend']
const roots = []
for (let i = 0; i < 12; i++) {
  const [a] = await same('post root ' + i, 'POST', '/messages', {
    channel: CHANNELS[i % 3],
    text: 'root ' + i + ' about ' + ['deploys', 'search', 'billing'][i % 3] + (i % 4 === 0 ? ' cc @[boards:user:alice]' : ''),
    labels: { kind: ['bug', 'idea', 'note'][i % 3], n: String(i) },
    ...(i % 2 === 0 ? { id: 'r-' + run + '-' + i } : {}),
  })
  roots.push(a.json.message.id)
}
const replies = []
for (let i = 0; i < 30; i++) {
  const root = roots[i % roots.length]
  const [a] = await same('reply ' + i, 'POST', '/messages', { re: root, text: 'reply ' + i + (i % 5 === 0 ? ' with @[boards:user:jared]' : ''), ...(i % 3 === 0 ? { id: 'p-' + run + '-' + i } : {}) }, { as: i % 2 ? 'alice' : 'jared' })
  replies.push(a.json.message.id)
}
for (let i = 0; i < 10; i++) await same('react ' + i, 'POST', '/messages/' + replies[i * 2] + '/reactions', { emoji: ['+1', 'eyes', 'tada'][i % 3] }, { as: i % 2 ? 'alice' : 'jared' })
await same('edit root', 'POST', '/messages/' + roots[1] + '/edit', { text: 'root 1, edited, about search' })
await same('delete reply', 'POST', '/messages/' + replies[4] + '/delete', {})
await same('delete root', 'POST', '/messages/' + roots[11] + '/delete', {})
await same('label reply', 'POST', '/messages/' + replies[6] + '/labels', { set: { status: 'triaged' } })
await both('upload', async (side) => {
  const answer = await side.call('POST', '/attachments', undefined, { raw: 'hello, archived file', headers: { 'content-type': 'text/plain', 'x-board-filename': 'note.txt' } })
  if (answer.json?.attachment?.id) side.files.set(answer.json.attachment.id, '<file0>')
  return answer
})
const fileOf = (side) => [...side.files.keys()][0]
await both('post with file', (side) => side.call('POST', '/messages', { channel: 'general', text: 'here is the file', attachments: [fileOf(side)] }))
const [t1] = await same('task 1', 'POST', '/tasks', { channel: 'eng/backend', text: 'ship the thing', id: 't1-' + run, labels: { area: 'ship' } })
const task1 = t1.json.task.id
await both('claim and complete task 1', async (side) => {
  const claim = await side.call('POST', '/tasks/' + task1 + '/claim', {})
  return side.call('POST', '/tasks/' + task1 + '/complete', { epoch: claim.json.claim.epoch, token: claim.json.claim.token, result: 'shipped' })
})
const finished = []
for (let i = 0; i < 4; i++) {
  const [made] = await same('finished task ' + i, 'POST', '/tasks', { channel: 'eng/backend', text: 'finished ' + i })
  const id = made.json.task.id
  finished.push(id)
  await both('claim and complete finished ' + i, async (side) => {
    const claim = await side.call('POST', '/tasks/' + id + '/claim', {})
    return side.call('POST', '/tasks/' + id + '/complete', { epoch: claim.json.claim.epoch, token: claim.json.claim.token, result: 'done ' + i })
  })
}
const [t2] = await same('task 2', 'POST', '/tasks', { channel: 'eng/backend', text: 'a task we drop' })
await same('cancel task 2', 'POST', '/tasks/' + t2.json.task.id + '/cancel', { reason: 'not needed' })
const [t3] = await same('task 3 needs 1', 'POST', '/tasks', { channel: 'eng/frontend', text: 'after the ship', needs: [task1] })
for (let i = 0; i < 20; i++) await same('filler ' + i, 'POST', '/messages', { channel: 'general', text: 'filler ' + i })
// A deep history: more cold threads than a filtered scan faults in at once.
await same('needle', 'POST', '/messages', { channel: 'deep', text: 'the needle is here', labels: { depth: 'bottom' } })
for (let i = 0; i < 150; i++) for (const side of [plain, archived]) await side.call('POST', '/messages', { channel: 'deep', text: 'deep ' + i, labels: { depth: String(i) } })

// -- reads -------------------------------------------------------------------------------------------
async function reads(phase) {
  for (const id of [...roots, replies[0], replies[7], replies[4], task1]) await same(phase + ' message ' + id, 'GET', '/messages/' + id)
  await same(phase + ' message limit', 'GET', '/messages/' + roots[0] + '?limit=1')
  await same(phase + ' message after', 'GET', '/messages/' + roots[0] + '?after=' + replies[0])
  for (const query of ['', '?limit=5', '?label=kind=bug', '?label=kind', '?label=status=triaged', '?by=alice', '?mentions=alice', '?mentions=me', '?text=search', '?channel=eng/', '?channel=general', '?re=' + roots[2], '?re=' + replies[3], '?label=nothing=here', '?label=board.task=completed', '?after=' + roots[3]])
    await same(phase + ' threads ' + query, 'GET', '/threads' + query)
  for (const query of ['?text=needle', '?text=nowhere-at-all', '?label=depth=bottom', '?channel=deep&text=deep 1&limit=5', '?channel=deep&limit=100'])
    await same(phase + ' deep threads ' + query, 'GET', '/threads' + query)
  await same(phase + ' deep channel', 'GET', '/messages?channel=deep&limit=100')
  await same(phase + ' deep channel after', 'GET', '/messages?channel=deep&after=0&limit=120')
  // Listings and filters but text answer from SQLite: no archived thread is read or put back.
  for (const query of ['', '?limit=5', '?label=kind=bug', '?by=alice', '?mentions=alice', '?label=kind=bug&by=alice', '?label=kind=idea&mentions=jared', '?channel=eng/', '?label=board.task=completed', '?channel=deep&limit=100', '?label=depth=bottom'])
    await sqliteOnly(phase + ' sqlite threads ' + query, '/threads' + query)
  for (const query of ['?state=all', '?state=completed', '?latest=true&state=all', '?label=area=ship&state=all'])
    await sqliteOnly(phase + ' sqlite tasks ' + query, '/tasks' + query)
  // Many reads at once while archival runs every 50 ms: each answers as the plain board does.
  for (const path of ['/threads', '/threads?after=5', '/threads?text=search', '/messages/' + roots[3], '/messages?channel=deep&limit=100', '/events?after=0'])
    await concurrently(phase + ' concurrent ' + path, path)
  // Paging back through every thread, frozen pages and all, and forward from the start.
  await both(phase + ' threads every page', async (side) => {
    const pages = []
    let older = null
    for (let i = 0; i < 80; i++) {
      const answer = await side.call('GET', '/threads?limit=7' + (older ? '&before=' + older : ''))
      pages.push(answer)
      older = answer.json?.older
      if (!older) break
    }
    return pages
  })
  for (const query of ['?after=0&limit=20', '?after=' + roots[5] + '&limit=500', '?after=' + replies[20]])
    await same(phase + ' threads ' + query, 'GET', '/threads' + query)
  const [page] = await same(phase + ' threads page 1', 'GET', '/threads?limit=4')
  if (page.json.older) await same(phase + ' threads older', 'GET', '/threads?limit=4&before=' + page.json.older)
  for (const query of ['?channel=general', '?channel=general&limit=5', '?channel=general&after=0&limit=5', '?channel=general&after=' + roots[3] + '&limit=7', '?channel=eng/backend', '?channel=eng/frontend&limit=2'])
    await same(phase + ' channel ' + query, 'GET', '/messages' + query)
  for (const query of ['?state=all', '?state=completed', '?state=canceled', '?state=open', '?latest=true&state=all', '?label=area=ship&state=all', '?by=jared&state=all'])
    await same(phase + ' tasks ' + query, 'GET', '/tasks' + query)
  for (const id of ['r-' + run + '-0', 'r-' + run + '-4', 'p-' + run + '-3', 't1-' + run, 'nothing-' + run]) await same(phase + ' posted ' + id, 'GET', '/posts/' + id)
  for (const key of ['r-' + run + '-6', 't1-' + run]) await same(phase + ' sync thread ' + key, 'GET', '/sync/threads/' + key)
  await same(phase + ' actors', 'GET', '/actors')
  await same(phase + ' actors narrowed', 'GET', '/actors', undefined, { headers: { 'x-board-can': 'general=read' } })
  await same(phase + ' threads narrowed', 'GET', '/threads', undefined, { headers: { 'x-board-can': 'general=read' } })
  await both(phase + ' file narrowed', async (side) => {
    // As someone who didn't upload it, reading only general: the file is theirs through the message that carries it.
    const response = await fetch(side.url + '/attachments/' + fileOf(side), { headers: { authorization: 'Bearer ' + token('alice', side.url), 'x-board-can': 'general=read' } })
    return { status: response.status, body: await response.text() }
  })
  await same(phase + ' channels', 'GET', '/channels')
  await same(phase + ' events last', 'GET', '/events?last=30')
  await same(phase + ' events last filtered', 'GET', '/events?last=10&channel=eng/')
  for (const query of ['', '&all=true', '&label=kind=bug', '&channel=general', '&by=alice'])
    await both(phase + ' feed' + query, async (side) => {
      const pages = []
      let after = '0'
      for (let i = 0; i < 50; i++) {
        const answer = await side.call('GET', '/events?after=' + after + query)
        pages.push(answer)
        if (answer.status !== 200 || answer.json.cursor === after) break
        after = answer.json.cursor
      }
      return pages
    })
  await same(phase + ' feed from mid', 'GET', '/events?after=17')
}
await reads('first')

// -- writes to archived threads -------------------------------------------------------------------
await same('reply to a cold root', 'POST', '/messages', { re: roots[5], text: 'back from the archive' })
await same('reply after', 'POST', '/messages', { re: roots[6], text: 'reply with after', after: replies[6] })
await same('react to a cold reply', 'POST', '/messages/' + replies[9] + '/reactions', { emoji: 'rocket' })
await same('unreact', 'POST', '/messages/' + replies[0] + '/reactions', { emoji: '+1', remove: true })
await same('edit a cold root', 'POST', '/messages/' + roots[2] + '/edit', { text: 'root 2, edited while cold' })
await same('label a cold root', 'POST', '/messages/' + roots[7] + '/labels', { set: { kind: 'bug' }, unset: ['n'] })
await same('delete a cold reply', 'POST', '/messages/' + replies[10] + '/delete', {})
await same('retry a keyed root', 'POST', '/messages', { channel: 'general', text: 'root 0 about deploys cc @[boards:user:alice]', labels: { kind: 'bug', n: '0' }, id: 'r-' + run + '-0' })
await same('retry a keyed reply', 'POST', '/messages', { re: roots[3], text: 'reply 3', id: 'p-' + run + '-3' }, { as: 'alice' })
await same('a keyed id from elsewhere', 'POST', '/messages', { channel: 'eng/backend', text: 'other', id: 'r-' + run + '-2' })
// Read into memory, then changed and archived again: a read after it sees the change.
await sameKept('kept: channel before', 'GET', '/messages?channel=eng/frontend&limit=50')
await sameKept('kept: text before', 'GET', '/threads?text=edited')
await sameKept('kept: edit', 'POST', '/messages/' + roots[2] + '/edit', { text: 'root 2, edited again while cold' })
await sameKept('kept: react', 'POST', '/messages/' + replies[2] + '/reactions', { emoji: 'eyes' })
await sameKept('kept: channel after', 'GET', '/messages?channel=eng/frontend&limit=50')
await sameKept('kept: text after', 'GET', '/threads?text=edited')
await same('task under a thread id', 'POST', '/tasks', { channel: 'general', text: 'x', id: 'r-' + run + '-4' })
await same('task of a cold thread', 'POST', '/tasks', { re: roots[8] })
await same('reopen a cold task', 'POST', '/tasks/' + task1 + '/reopen', {})
await same('needs a cold task', 'POST', '/tasks', { channel: 'eng/frontend', text: 'needs the old one', needs: [t2.json.task.id] })
// A write that puts several threads back at once, while archival runs every 50 ms: each must
// stay back until the write lands.
for (let i = 0; i < 3; i++) await same('needs four cold tasks ' + i, 'POST', '/tasks', { channel: 'eng/frontend', text: 'needs them all ' + i, needs: [task1, ...finished] })
await reads('second')

const status = await archiveAll()
console.log(JSON.stringify({ compared, coldReads, differences: differences.length, archived: { hot: status.hot, sealed: status.sealed, cold: status.cold, frozen: status.frozen, loads: status.loads }, pageReads: Object.fromEntries(pageReads.map((entry) => [entry.label, entry.pages])) }, null, 1))
for (const difference of differences.slice(0, 10)) console.log('DIFFERS: ' + difference.label + '\n  plain:    ' + JSON.stringify(difference.plain).slice(0, 1500) + '\n  archived: ' + JSON.stringify(difference.archived).slice(0, 1500))
process.exit(differences.length ? 1 : 0)
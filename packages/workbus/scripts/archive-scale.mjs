// Archival at scale: fills a board with a long history of one thread shape, archives it (sealed,
// cold, frozen), and reports what stays hot (SQLite) against what moved to R2, then how long reads
// of the archived history take.
//
//   node scripts/archive-scale.mjs [--origin http://127.0.0.1:8811] [--shape long|short] [--history 200000] [--recent 2000]
//
// long: threads of 10 messages. short: threads of 1 or 2 (1.5 on average).
// The Worker must run with ARCHIVE_BENCH=1 (wrangler dev --var ARCHIVE_BENCH:1): the fill posts
// through the board's own postMessage, many to a request, with their times set. The history is 200
// days old and the recent activity 10 days; archival runs with its thresholds at 100 days, and
// freezes every thread it cools, as a board would once its history aged past the horizon.
import { execFileSync } from 'node:child_process'

const args = Object.fromEntries(process.argv.slice(2).reduce((out, arg, i, all) => (arg.startsWith('--') ? [...out, [arg.slice(2), all[i + 1]]] : out), []))
const origin = (args.origin ?? 'http://127.0.0.1:8811').replace(/\/+$/, '')
const SHAPE = args.shape ?? 'long'
const HISTORY = Number(args.history ?? 200_000)
const RECENT = Number(args.recent ?? 2_000)
const DAY = 86_400_000
// --board names a board this script filled before: only its reads are measured again.
const board = args.board ?? 'scale-' + SHAPE + '-' + Date.now().toString(36)
const url = origin + '/b/' + board
const token = execFileSync('node', ['scripts/issuer.mjs', 'token', 'jared', url], { encoding: 'utf8' }).trim()

async function call(method, path, body) {
  const started = performance.now()
  const response = await fetch(url + path, { method, headers: { authorization: 'Bearer ' + token, 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) })
  const json = await response.json()
  const ms = performance.now() - started
  if (!response.ok) throw new Error(method + ' ' + path + ': ' + response.status + ' ' + JSON.stringify(json))
  return { json, ms }
}
const status = async (live = false) => (await call('GET', '/archive' + (live ? '?live=1' : ''))).json
const mb = (bytes) => (bytes / 1e6).toFixed(2) + ' MB'
const stats = (list) => {
  const sorted = [...list].sort((a, b) => a - b)
  const at = (p) => sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))]
  return { n: list.length, p50: +at(0.5).toFixed(1), p90: +at(0.9).toFixed(1), max: +sorted.at(-1).toFixed(1) }
}

/** Posts messages in threads of the shape, over spanMs from at: 5,000 messages a request. */
async function fill(channel, messages, at, spanMs, prefix, keyed = true) {
  const shapes = SHAPE === 'long' ? [{ replies: 9, share: 1 }] : [{ replies: 0, share: 0.5 }, { replies: 1, share: 0.5 }]
  const perThread = shapes.reduce((sum, shape) => sum + shape.share * (1 + shape.replies), 0)
  const threads = Math.round(messages / perThread)
  let done = 0
  while (done < threads) {
    for (const shape of shapes) {
      const count = Math.max(1, Math.min(Math.round((5000 / perThread) * shape.share), Math.round((threads - done) * shape.share)))
      await call('POST', '/archive/fill', { channel, threads: count, replies: shape.replies, at: Math.round(at + (done / threads) * spanMs), spanMs: Math.round((spanMs * count) / threads), keyed, prefix: prefix + done })
    }
    done += Math.round(5000 / perThread)
  }
}

async function archive(thresholdMs) {
  const started = Date.now()
  await call('POST', '/archive', { sealAfterMs: thresholdMs, coldAfterMs: thresholdMs, freezeAfterMs: 0, run: true })
  for (;;) {
    const now = await status()
    if (now.last && now.last.at >= started && !now.last.more) return (Date.now() - started) / 1000
    await new Promise((resolve) => setTimeout(resolve, 500))
  }
}

/** A read, cold: what the board read back dropped from memory first; with what it loaded from R2. */
async function cold(path, method = 'GET', body) {
  await call('POST', '/archive', { forget: true })
  const before = (await status()).loads
  const answer = await call(method, path, body)
  const after = (await status()).loads
  return { ms: +answer.ms.toFixed(1), json: answer.json, r2: { pages: after.pages - before.pages, threads: after.read - before.read, restored: after.restored - before.restored, segments: after.segments - before.segments } }
}

let fillSeconds = 0
let archiveSeconds = 0
let before = null
if (!args.board) {
  await call('POST', '/archive', { enabled: true, segment: 1000, keep: 1000, everyMs: 3_600_000, stepThreads: 1000, pageThreads: 256, pauseMs: 0 })
  const now = Date.now()
  const filled = Date.now()
  for (let c = 0; c < 4; c++) await fill('history/' + c, HISTORY / 4, now - 200 * DAY + c * DAY, DAY, 'h' + c)
  await fill('team', RECENT, now - 10 * DAY, DAY, 'r')
  fillSeconds = (Date.now() - filled) / 1000
  before = await status(true)
  archiveSeconds = await archive(100 * DAY)
}
const after = await status(true)
const residueKeys = ['coldThreads', 'coldKeys', 'coldRows', 'coldFacets', 'coldAuthors', 'segments', 'frozenPages', 'frozenGone', 'frozenFiles']
const residue = residueKeys.reduce((sum, key) => sum + (after.live[key] ?? 0), 0)
const archived = after.frozen.messages + after.cold.messages
if (before) console.log(SHAPE + ': ' + (HISTORY + RECENT) + ' messages; hot before ' + mb(before.databaseSize) + ', after ' + mb(after.databaseSize) + ' (live ' + mb(after.live.total) + '); archive residue ' + mb(residue) + ' = ' + (residue / archived).toFixed(2) + ' B per archived message; R2 ' + mb(after.sealed.bytes + after.cold.bytes + after.frozen.bytes) + '; fill ' + fillSeconds.toFixed(0) + ' s, archive ' + archiveSeconds.toFixed(0) + ' s')

// -- reading past the horizon ----------------------------------------------------------------------
const latency = {}
const listing = async (path) => {
  const out = await cold(path)
  return { ms: out.ms, threads: out.json.threads.length, r2: out.r2 }
}
latency.newestPage = await listing('/threads?limit=50')
// A page deep in the frozen history: before the 50th oldest thread (last.root).
const oldest = await call('GET', '/threads?after=0&limit=60')
const pivot = oldest.json.threads[50]
const deepCursor = (pivot.last ?? pivot.message).id + '.' + pivot.message.id
const deep = await call('GET', '/threads?limit=50&before=' + deepCursor)
latency.deepPage = await listing('/threads?limit=50&before=' + deepCursor)
latency.deepPageAgain = { ms: +(await call('GET', '/threads?limit=50&before=' + deepCursor)).ms.toFixed(1) }
latency.channelFilter = await listing('/threads?channel=history/1&limit=50')
latency.labelFilter = await listing('/threads?label=shard=3&limit=50')
latency.labelChannelFilter = await listing('/threads?label=shard=3&channel=history/0&limit=50')
latency.byFilterDeep = await listing('/threads?by=jared&limit=50&before=' + deepCursor)
latency.noMatch = await listing('/threads?label=kind=nothing&limit=50')
latency.textSearch = await listing('/threads?channel=history/3&text=' + encodeURIComponent('message 1') + '&limit=5')
const roots = deep.json.threads.map((thread) => thread.message.id)
const message = []
for (const root of roots.slice(0, 5)) message.push(await cold('/messages/' + root))
latency.messageFrozen = { ...stats(message.map((entry) => entry.ms)), r2: message[0].r2 }
const reply = await cold('/messages', 'POST', { re: roots[10], text: 'a reply to a frozen thread' })
latency.replyFrozen = { ms: reply.ms, r2: reply.r2 }
const posted = await cold('/posts/' + encodeURIComponent(deep.json.threads[20].message.thread))
latency.postedFrozen = { ms: posted.ms, r2: posted.r2 }
const feed = await cold('/events?after=' + Math.floor(HISTORY / 3))
latency.feedPage = { ms: feed.ms, events: feed.json.events.length, r2: feed.r2 }
const final = await status(true)
console.log(JSON.stringify({ board, shape: SHAPE, messages: HISTORY + RECENT, fillSeconds, archiveSeconds, before: before && { databaseSize: before.databaseSize, live: before.live.total }, after: { databaseSize: after.databaseSize, live: after.live, hot: after.hot, sealed: after.sealed, cold: after.cold, frozen: after.frozen }, residue: { bytes: residue, perArchivedMessage: +(residue / archived).toFixed(2), archivedMessages: archived }, latency, final: { databaseSize: final.databaseSize, loads: final.loads, frozen: final.frozen, cold: final.cold } }, null, 1))

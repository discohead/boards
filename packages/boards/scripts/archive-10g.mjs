// Archival past 10 GB: fills a board in rounds, each round's history dated past the archive
// horizon, and archives it before the next, as a board ages. Each round reports the Durable Object's
// own SQLite size (databaseSize) before and after archival. History is what the board would hold
// with no archival: the sum of every round's growth before it was archived.
//   node scripts/archive-10g.mjs --origin <url> [--target-gb 10.5] [--round 100000] [--text 2000] [--board name]
import { execFileSync } from 'node:child_process'
import { appendFileSync } from 'node:fs'

const args = Object.fromEntries(process.argv.slice(2).reduce((out, arg, i, all) => (arg.startsWith('--') ? [...out, [arg.slice(2), all[i + 1]]] : out), []))
const origin = (args.origin ?? 'http://127.0.0.1:8811').replace(/\/+$/, '')
const TARGET = Number(args['target-gb'] ?? 10.5) * 1e9
const ROUND = Number(args.round ?? 100_000)
const TEXT = Number(args.text ?? 2000)
const ROUNDS = Number(args.rounds ?? 1000)
const LOG = args.log ?? null
const board = args.board ?? '10g-' + Date.now().toString(36)
const url = origin + '/b/' + board
const DAY = 86_400_000
let token = ''
let tokenAt = 0
const auth = () => {
  if (Date.now() - tokenAt > 3_600_000) (token = execFileSync('node', ['scripts/issuer.mjs', 'token', 'jared', url], { encoding: 'utf8' }).trim()), (tokenAt = Date.now())
  return token
}
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
async function call(method, path, body, tries = 30) {
  for (let attempt = 1; ; attempt++) {
    const response = await fetch(url + path, { method, headers: { authorization: 'Bearer ' + auth(), 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) }).catch((error) => ({ ok: false, status: 0, json: async () => ({ error: String(error) }) }))
    const json = await response.json().catch(() => null)
    if (response.ok) return json
    if (attempt >= tries) throw new Error(method + ' ' + path + ': ' + response.status + ' ' + JSON.stringify(json))
    await sleep(Math.min(30_000, 1000 * 2 ** Math.min(attempt, 5)))
  }
}
const out = (line) => {
  console.log(line)
  if (LOG) appendFileSync(LOG, line + '\n')
}
const gb = (bytes) => (bytes / 1e9).toFixed(3) + ' GB'
const mb = (bytes) => (bytes / 1e6).toFixed(1) + ' MB'
const r2Bytes = (s) => (s.sealed?.bytes ?? 0) + (s.cold?.bytes ?? 0) + (s.frozen?.bytes ?? s.pages?.bytes ?? 0)

// Old history: every round lands 400 to 200 days ago, newest last; archival works at 100 days.
const horizon = 100 * DAY
// freezeAfterMs counts time spent cold; this history is already past the horizon, so it freezes as it cools.
await call('POST', '/archive', { enabled: false, sealAfterMs: horizon, coldAfterMs: horizon, freezeAfterMs: 0, everyMs: 50 })
let history = 0
let messages = 0
const startedAt = Date.now()
// --resume: the board already holds unarchived history; count it, and archive it first.
if (args.resume) {
  const s0 = await call('GET', '/archive')
  history = s0.databaseSize
  messages = s0.hot.messages
  out('resume  board ' + board + '  history ' + gb(history) + '  messages ' + messages)
}
for (let round = 1; round <= ROUNDS && history < TARGET; round++) {
  const before0 = (await call('GET', '/archive')).databaseSize
  const t0 = Date.now()
  const threads = args.resume && round === 1 ? 0 : Math.round(ROUND / 10)
  const at = Date.now() - 400 * DAY + ((round - 1) % 200) * DAY
  // 1,000 messages a request: a fill transaction stays short as the board grows, well inside the edge's timeout.
  for (let done = 0; done < threads; done += 100) await call('POST', '/archive/fill', { channel: 'history/' + (round % 8), threads: Math.min(100, threads - done), replies: 9, at: at + done * 1000, spanMs: 500_000, text: TEXT, keyed: true, prefix: 'r' + round + '-' + done + '-' })
  const filled = await call('GET', '/archive')
  const fillMs = Date.now() - t0
  const t1 = Date.now()
  // Archival runs between fills, so a fill never waits behind an archive step.
  await call('POST', '/archive', { enabled: true, run: true })
  let s = filled
  for (let i = 0; i < 20_000; i++) {
    await sleep(3000)
    s = await call('GET', '/archive')
    if (s.last && s.last.at >= t1 - 60_000 && !s.last.more && s.hot.messages <= 1000) break
  }
  await call('POST', '/archive', { enabled: false })
  const growth = filled.databaseSize - before0
  history += growth
  messages += threads * 10
  out(['round ' + round, 'messages ' + messages, 'history ' + gb(history), 'before ' + mb(filled.databaseSize), 'after ' + mb(s.databaseSize), 'hot msgs ' + s.hot.messages, 'R2 ' + gb(r2Bytes(s)), 'fill ' + (fillMs / 1000).toFixed(0) + 's', 'archive ' + ((Date.now() - t1) / 1000).toFixed(0) + 's', 'elapsed ' + ((Date.now() - startedAt) / 60000).toFixed(0) + 'm'].join('  '))
}
const final = await call('GET', '/archive?live=1')
out('final  board ' + board + '  history ' + gb(history) + '  messages ' + messages + '  databaseSize ' + mb(final.databaseSize) + '  ' + JSON.stringify({ hot: final.hot, sealed: final.sealed, cold: final.cold, frozen: final.frozen ?? final.pages ?? null, live: final.live ?? null }))

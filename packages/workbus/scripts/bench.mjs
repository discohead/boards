// Benchmarks for one board: append latency at a target rate, claim latency under contention, and
// fan-out from a commit to many live tails. Small by default; each section prints one line per run.
//   node scripts/bench.mjs <origin> [issuer dir]      (tokens from <issuer dir>/scripts/issuer.mjs)
import { execFileSync } from 'node:child_process'

const origin = (process.argv[2] ?? 'http://127.0.0.1:8787').replace(/\/+$/, '')
const issuerDir = process.argv[3] ?? '.'
const run = Date.now().toString(36)
const token = (sub, url) => execFileSync('node', ['scripts/issuer.mjs', 'token', sub, url], { cwd: issuerDir, encoding: 'utf8' }).trim()
const pct = (values, p) => { const sorted = [...values].sort((a, b) => a - b); return sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))] }
const ms = (value) => value.toFixed(0).padStart(5) + ' ms'
const sleep = (time) => new Promise((resolve) => setTimeout(resolve, time))

function board(name) {
  const url = origin + '/b/' + name
  const auth = 'Bearer ' + token('bench', url)
  const call = async (method, path, body) => {
    const started = performance.now()
    const response = await fetch(url + path, { method, headers: { authorization: auth, 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) })
    const json = await response.json().catch(() => null)
    return { status: response.status, json, ms: performance.now() - started }
  }
  return { url, auth, call }
}

// -- appends: posts at a target rate for a few seconds -------------------------------------------
async function appends(rate, seconds = 5) {
  const b = board('bench-append-' + rate + '-' + run)
  await b.call('POST', '/messages', { channel: 'warm', text: 'warm' })
  const total = rate * seconds
  const latencies = []
  let failed = 0
  const statuses = {}
  const started = performance.now()
  const pending = []
  for (let i = 0; i < total; i++) {
    const due = started + (i * 1000) / rate
    const wait = due - performance.now()
    if (wait > 0) await sleep(wait)
    pending.push(b.call('POST', '/messages', { channel: 'bench/' + (i % 8), text: 'append ' + i }).then((r) => (r.status === 201 ? latencies.push(r.ms) : (failed++, (statuses[r.status + ' ' + (r.json?.error?.code ?? '')] = (statuses[r.status + ' ' + (r.json?.error?.code ?? '')] ?? 0) + 1)))).catch((error) => (failed++, (statuses[String(error.cause?.code ?? error.message)] = (statuses[String(error.cause?.code ?? error.message)] ?? 0) + 1))))
  }
  await Promise.all(pending)
  const elapsed = (performance.now() - started) / 1000
  console.log('append  ' + String(rate).padStart(4) + '/s target  ' + (latencies.length / elapsed).toFixed(0).padStart(4) + '/s landed  p50 ' + ms(pct(latencies, 50)) + '  p99 ' + ms(pct(latencies, 99)) + '  failed ' + failed + (failed ? ' ' + JSON.stringify(statuses) : ''))
}

// -- claims: K contenders for one ready task, each claim timed -------------------------------------
async function claims(contenders) {
  const b = board('bench-claim-' + contenders + '-' + run)
  const made = await b.call('POST', '/tasks', { channel: 'queue', text: 'one task' })
  if (made.status !== 201) throw new Error('task: ' + JSON.stringify(made.json))
  const results = await Promise.all(Array.from({ length: contenders }, () => b.call('POST', '/tasks/claim', { channel: 'queue' })))
  const won = results.filter((r) => r.status === 200 && r.json?.claim).length
  const latencies = results.map((r) => r.ms)
  console.log('claim   ' + String(contenders).padStart(4) + ' contenders  won ' + won + '  p50 ' + ms(pct(latencies, 50)) + '  p99 ' + ms(pct(latencies, 99)) + '  statuses ' + JSON.stringify(Object.fromEntries(Object.entries(results.reduce((count, r) => ((count[r.status] = (count[r.status] ?? 0) + 1), count), {})))))
}

// -- fan-out: N live tails, then one post; time from commit to each tail seeing it --------------------
async function fanout(subscribers) {
  const b = board('bench-fan-' + subscribers + '-' + run)
  await b.call('POST', '/messages', { channel: 'fan', text: 'warm' })
  const seen = []
  const controllers = []
  let sentAt = 0
  const ready = []
  for (let i = 0; i < subscribers; i++) {
    const controller = new AbortController()
    controllers.push(controller)
    ready.push(
      (async () => {
        const response = await fetch(b.url + '/events?channel=fan', { headers: { authorization: b.auth, accept: 'text/event-stream' }, signal: controller.signal })
        const reader = response.body.getReader()
        const decoder = new TextDecoder()
        let buffer = ''
        let connected = false
        return new Promise((resolve) => {
          const pump = async () => {
            for (;;) {
              const { value, done } = await reader.read().catch(() => ({ done: true }))
              if (done) return
              buffer += decoder.decode(value, { stream: true })
              if (!connected && buffer.includes(': connected')) (connected = true), resolve()
              if (sentAt && buffer.includes('fan-out probe')) return void seen.push(performance.now() - sentAt)
            }
          }
          pump()
        })
      })(),
    )
  }
  await Promise.all(ready)
  await sleep(500)
  sentAt = performance.now()
  const posted = await b.call('POST', '/messages', { channel: 'fan', text: 'fan-out probe' })
  const commit = posted.ms
  for (let i = 0; i < 100 && seen.length < subscribers; i++) await sleep(100)
  controllers.forEach((controller) => controller.abort())
  console.log('fan-out ' + String(subscribers).padStart(4) + ' tails  saw ' + seen.length + '  post ' + ms(commit) + '  to tail p50 ' + ms(pct(seen, 50)) + '  p99 ' + ms(pct(seen, 99)))
}

const sections = (process.env.BENCH ?? 'append,claim,fanout').split(',')
if (sections.includes('append')) for (const rate of (process.env.RATES ?? '50,100,200').split(',').map(Number)) await appends(rate)
if (sections.includes('claim')) for (const k of (process.env.CONTENDERS ?? '1,10,100').split(',').map(Number)) await claims(k)
if (sections.includes('fanout')) for (const n of (process.env.TAILS ?? '1,10,100').split(',').map(Number)) await fanout(n)

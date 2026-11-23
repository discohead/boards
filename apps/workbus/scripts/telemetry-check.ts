// A real run of the telemetry module (src/telemetry/) without a Worker: the Run schema, the row the
// stream runs_v1 takes (checked against its schema file), the Seat's totals in SQLite (node:sqlite
// stands in for a Durable Object's ctx.storage.sql), delivery that survives a failed send, and the
// Basin SQL for cost per seat.
//   node scripts/telemetry-check.ts
import { DatabaseSync } from 'node:sqlite'
import { readFileSync } from 'node:fs'
import { Run, Totals, record, runOf, toRow, usageOf, type RunRow, type Sql } from '../src/telemetry/index.ts'
import { costPerSeatSql } from '../src/telemetry/basin.ts'

let failures = 0
const check = (ok: boolean, what: string, detail: unknown = '') => {
  if (!ok) failures++
  console.log((ok ? 'ok   ' : 'FAIL ') + what + (detail === '' ? '' : '  ' + (typeof detail === 'string' ? detail : JSON.stringify(detail))))
}

const sqlite = (): Sql => {
  const db = new DatabaseSync(':memory:')
  return { exec: (query, ...bindings) => {
    const statement = db.prepare(query)
    const rows = /^\s*(SELECT|WITH)/i.test(query) ? statement.all(...bindings) : (statement.run(...bindings), [])
    return { toArray: () => rows as Record<string, unknown>[] }
  } }
}

const run = (over: Partial<Run> = {}): Run => ({
  id: 'run-1', seat: 'ada', team: 'eng', thread: 'ada:thread-1', task: null, operation: 'op-1', harness: 'pi',
  model: 'anthropic/claude-haiku-5.5', charter: 'rev-1', started: '2026-11-23T08:00:00.000Z', ended: '2026-11-23T08:00:03.000Z',
  outcome: 'answered', steps: 1, tools: [{ name: 'write', ms: 12, ok: true }],
  tokens: { input: 4, output: 4, cacheRead: 0, cacheWrite: 3502 }, cost: 0.00044015, costSource: 'pi', logIds: ['01a20789'], error: null, ...over,
})

// The schema refuses what the stream would drop.
check(Run.safeParse(run()).success, 'a full run parses')
for (const [what, bad] of [['a negative cost', { cost: -1 }], ['an unknown outcome', { outcome: 'done' }], ['an empty seat', { seat: '' }],
  ['a date without a zone', { ended: '2026-11-23 08:00' }], ['fractional tokens', { tokens: { input: 1.5, output: 0, cacheRead: 0, cacheWrite: 0 } }]] as const)
  check(!Run.safeParse(run(bad as Partial<Run>)).success, 'refuses ' + what)

// The row fits runs_v1's schema: every field it names, of its type, and nothing else.
const schema = JSON.parse(readFileSync(new URL('../src/telemetry/runs_v1.schema.json', import.meta.url), 'utf8')) as { fields: { name: string; type: string; required: boolean }[] }
const fits = (row: RunRow) => {
  const problems: string[] = []
  const names = new Set(schema.fields.map((f) => f.name))
  for (const key of Object.keys(row)) if (!names.has(key)) problems.push('extra ' + key)
  for (const field of schema.fields) {
    const value = (row as Record<string, unknown>)[field.name]
    if (value === undefined || value === null) { if (field.required) problems.push('missing ' + field.name); continue }
    const want = { string: 'string', timestamp: 'string', int32: 'number', int64: 'number', float64: 'number', bool: 'boolean', list: 'array' }[field.type]
    const got = Array.isArray(value) ? 'array' : typeof value
    if (got !== want) problems.push(field.name + ' is ' + got)
  }
  return problems
}
check(fits(toRow(run())).length === 0, 'a row fits runs_v1', fits(toRow(run())))
check(fits(toRow(run({ team: null, task: null, charter: null, error: null }))).length === 0, 'a row with no team, task, charter, or error fits', toRow(run({ team: null })))
check(!('task' in toRow(run())), 'a null becomes an absent field')

// The Seat's totals: one count per run id, summed per month.
const totals = new Totals(sqlite())
check(totals.add(run()) === true, 'a new run is added')
check(totals.add(run()) === false, 'the same run again is not added twice')
totals.add(run({ id: 'run-2', cost: 0.001, tokens: { input: 10, output: 20, cacheRead: 3502, cacheWrite: 0 } }))
totals.add(run({ id: 'run-3', ended: '2026-12-01T00:00:00.000Z', cost: 0.5 }))
totals.add(run({ id: 'run-4', seat: 'op', cost: 7 }))
const november = totals.spend('ada', '2026-11')
check(november.runs === 2 && Math.abs(november.cost - 0.00144015) < 1e-12, "ada's November is two runs and their cost", november)
check(november.tokens.input === 14 && november.tokens.cacheRead === 3502, "ada's November tokens", november.tokens)
check(totals.spend('ada', '2026-12').cost === 0.5, 'a run that ended in December counts in December')
check(totals.periods('ada').map((p) => p.period).join() === '2026-12,2026-11', 'periods, newest first')
// Container time rides in tools[] as sandbox:<instance>, apart from the model's cost.
totals.add(run({ id: 'run-6', cost: 0, tools: [{ name: 'sandbox_exec', ms: 900, ok: true }, { name: 'sandbox:basic', ms: 301_000, ok: true }] }))
totals.add(run({ id: 'run-7', cost: 0, tools: [{ name: 'sandbox:basic', ms: 2_000, ok: true }] }))
const boxed = totals.spend('ada', '2026-11')
check(boxed.sandbox.ms === 303_000 && Math.abs(boxed.cost - 0.00144015) < 1e-12, "the sandbox's container time sums apart from the model's cost", boxed.sandbox)
check(totals.spend('op', '2026-11').sandbox.ms === 0, 'and only the seat that ran it')
let threw = false
try { totals.add(run({ id: 'run-5', cost: -2 })) } catch { threw = true }
check(threw && totals.spend('ada', '2026-11').runs === 4, 'an invalid run is refused and not counted')

// Delivery: a failed send leaves runs unsent; the next record sends them all, once.
const delivery = new Totals(sqlite())
const got: RunRow[] = []
let down = true
const stream = { async send(rows: RunRow[]) { if (down) throw new Error('stream down'); got.push(...rows) } }
const first = await record(delivery, stream, run())
check(first.added && first.sent === 0 && !!first.error && delivery.unsent() === 1, 'a failed send keeps the run, unsent', first)
down = false
const second = await record(delivery, stream, run({ id: 'run-2' }))
check(second.sent === 2 && delivery.unsent() === 0 && got.map((r) => r.id).join() === 'run-1,run-2', 'the next record sends both, oldest first', second)
await record(delivery, stream, run({ id: 'run-2' }))
check(got.length === 2, 'recording a run again sends nothing')
for (let i = 0; i < 250; i++) delivery.add(run({ id: 'bulk-' + i }))
check((await delivery.flush(stream)) === 250 && got.length === 252, 'flush sends in batches until none are left')
check(delivery.resend() === 252 && (await delivery.flush(stream)) === 252 && delivery.unsent() === 0, 'resend() delivers every run again, for a backfill')
check(delivery.resend('2027-01-01T00:00:00Z') === 0, 'resend(since) leaves older runs alone')

// Usage from pi's responses: tokens and cost summed, the gateway's log ids kept once each.
const usage = usageOf([
  { usage: { input: 4, output: 4, cacheRead: 0, cacheWrite: 3502, cost: { total: 0.00044015 } }, diagnostics: [{ type: 'cloudflare', details: { logId: 'log-a' } }] },
  { usage: { input: 6, output: 9, cacheRead: 3502, cacheWrite: 0, cost: { total: 0.0001 } }, diagnostics: [{ type: 'cloudflare', details: { logId: 'log-b' } }, { type: 'x', details: { logId: 'log-a' } }] },
])
check(usage.steps === 2 && usage.tokens.input === 10 && usage.tokens.cacheRead === 3502 && Math.abs(usage.cost - 0.00054015) < 1e-12, 'usageOf sums two responses', usage)
check(usage.logIds.join() === 'log-a,log-b', 'usageOf keeps each log id once', usage.logIds)

// From the harness's outcome (its real sample, verified on Haiku through the workbus gateway).
const sample = { model: 'anthropic/claude-haiku-5.5', steps: 3, tokens: { input: 8, output: 165, cacheRead: 6305, cacheWrite: 3349 }, cost: 0.000564975,
  tools: [{ name: 'write', ms: 5, ok: true }, { name: 'exec', ms: 22, ok: true }], logs: ['log-1', 'log-2', 'log-3'], started: '2026-11-23T09:00:00.000Z', ended: '2026-11-23T09:00:04.000Z' }
const seatFields = { seat: 'ada', team: 'eng', thread: 'ada:thread-1', task: 'task-1', charter: 'rev-3' }
const answered = runOf({ operationId: 'cursor-41', status: 'done', usage: sample }, seatFields)
check(answered?.outcome === 'answered' && answered.id === 'ada:cursor-41' && answered.cost === 0.000564975 && answered.logIds.length === 3 && fits(toRow(answered)).length === 0, 'an answered operation becomes a run that fits runs_v1', answered)
check(runOf({ operationId: 'cursor-42', status: 'unanswered', reason: 'aborted', usage: sample }, seatFields)?.outcome === 'aborted', 'an aborted operation')
const failedRun = runOf({ operationId: 'cursor-43', status: 'unanswered', reason: 'model_error', usage: { ...sample, ended: null } }, seatFields, '2026-11-23T09:01:00.000Z')
check(failedRun?.outcome === 'failed' && failedRun.error === 'model_error' && failedRun.ended === '2026-11-23T09:01:00.000Z', 'a failed operation keeps its reason, and ends now if the harness had no end', failedRun)
check(runOf({ operationId: 'cursor-44', status: 'done', usage: sample }, { ...seatFields, overBudget: true })?.outcome === 'over_budget', 'over budget, as the Seat says')
check(runOf({ operationId: 'cursor-45', status: 'done', usage: { ...sample, steps: 0, tools: [], logs: [] }, resumes: 'cursor-41' }, seatFields) === null, "an approval's answer has no record of its own")

// The Basin query for cost per seat: the month's bounds, December into January.
check(costPerSeatSql('2026-11').includes("ended >= '2026-11-01T00:00:00Z' AND ended < '2026-12-01T00:00:00Z'"), 'November bounds')
check(costPerSeatSql('2026-12').includes("ended < '2027-01-01T00:00:00Z'"), 'December runs into January')

console.log(failures ? failures + ' failed' : 'all passed')
process.exit(failures ? 1 : 0)

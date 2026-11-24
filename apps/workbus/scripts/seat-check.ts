// The Seat's queue statements (src/seats/queue.ts), run in node:sqlite: a thread parked on a hold
// is waiting, even with a wake running behind it; a thread running with no hold is working.
//   node scripts/seat-check.ts
import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import { RUNNING_UNHELD, WAKES_DDL, takesNoTurn } from '../src/seats/queue.ts'
import { budgetStep, budgetText, nextPeriod } from '../src/seats/budget.ts'

const db = new DatabaseSync(':memory:')
db.exec(WAKES_DDL)
const add = (id: string, thread: string, state: string) => db.prepare('insert into wakes (id, thread, input, state, at) values (?, ?, ?, ?, ?)').run(id, thread, '{}', state, Date.now())
const working = () => db.prepare(RUNNING_UNHELD).all().map((row) => String(row.thread)).sort()

add('a:1', '984', 'held') // the operation parked on approval #988
add('a:2', '984', 'running') // a follow-up wake that started at once, behind it in the session
assert.deepEqual(working(), [], 'a parked thread with a wake behind it is waiting, not working')
add('a:3', '990', 'running')
assert.deepEqual(working(), ['990'], 'a thread running with no hold is working, and holds a slot')
add('a:4', '990', 'done')
assert.deepEqual(working(), ['990'])
// The budget's steps (src/seats/budget.ts): the alert once at alert × month, the limit at month, a
// raised budget or a new period closing the limit, and nothing held twice in a period.
const budget = { month: 0.01, alert: 0.8 }
const none = { period: '2026-11' }
assert.equal(budgetStep(0.007, budget, none, '2026-11'), null, 'under the alert: nothing')
assert.deepEqual(budgetStep(0.008, budget, none, '2026-11'), { hold: 'alert' }, 'at 80%: the alert')
assert.equal(budgetStep(0.009, budget, { period: '2026-11', alert: { task: '1', open: true } }, '2026-11'), null, 'the alert once a period')
assert.equal(budgetStep(0.009, budget, { period: '2026-11', alert: { task: '1', open: false } }, '2026-11'), null, 'an answered alert stays answered')
assert.deepEqual(budgetStep(0.01, budget, { period: '2026-11', alert: { task: '1', open: true } }, '2026-11'), { hold: 'limit' }, 'at the limit: the limit task')
assert.deepEqual(budgetStep(0.02, budget, none, '2026-11'), { hold: 'limit' }, 'past the limit at once: only the limit, no alert')
const limited = { period: '2026-11', limit: { task: '2', open: true } }
assert.equal(budgetStep(0.012, budget, limited, '2026-11'), null, 'the limit once a period')
assert.deepEqual(budgetStep(0.012, { month: 0.05, alert: 0.8 }, limited, '2026-11'), { close: 'limit', why: 'raised' }, 'a raised budget closes it')
assert.deepEqual(budgetStep(0, budget, limited, '2026-12'), { close: 'limit', why: 'period' }, 'a new period closes it')
assert.equal(budgetStep(5, { month: null, alert: 0.8 }, none, '2026-11'), null, 'no budget, no tasks')
assert.equal(nextPeriod(Date.parse('2026-12-31T23:59:59Z')), Date.parse('2027-01-01T00:00:00Z'))
assert.match(budgetText('limit', { key: 'ada', name: 'Ada' }, 0.0123, 0.01, '2026-11', 2).text, /^Ada has spent \$0\.0123 of its \$0\.01 budget for November 2026, its limit, and has stopped starting runs \(2 wake-ups wait\)\.$/)
// What the Seat acks without a turn (takesNoTurn): a deleted message from any rule, moderated or
// not; a doc's change but to a docs rule. A post, a cancel, and a doc to a docs rule still take one.
assert.equal(takesNoTurn({ type: 'message.deleted' }, ['answered']), true, "a deleted message through a tail: no turn")
assert.equal(takesNoTurn({ type: 'message.deleted' }, ['docs']), true, 'a deleted doc root through docs: no turn either')
assert.equal(takesNoTurn({ type: 'doc.edited' }, ['mention']), true, "a doc's edit to a mention: no turn")
assert.equal(takesNoTurn({ type: 'doc.edited' }, ['docs']), false, 'a doc edited, to a docs rule: a turn')
assert.equal(takesNoTurn({ type: 'message.posted' }, ['dm']), false, 'a post: a turn')
assert.equal(takesNoTurn({ type: 'task.canceled' }, ['owned']), false, 'a cancel: a turn')
console.log('ok: 21 checks passed')

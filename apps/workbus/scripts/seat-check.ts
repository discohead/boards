// The Seat's queue statements (src/seats/queue.ts), run in node:sqlite: a thread parked on a hold
// is waiting, even with a wake running behind it; a thread running with no hold is working.
//   node scripts/seat-check.ts
import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import { RUNNING_UNHELD, WAKES_DDL } from '../src/seats/queue.ts'

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
console.log('ok: 3 checks passed')

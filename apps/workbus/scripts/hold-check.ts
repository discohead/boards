// The held row: a live re-sort never moves the selected row out of its group or its place there.
//   node scripts/hold-check.ts
import { holdSelected, type Placed } from '../src/task/hold.ts'

let failures = 0
const check = (ok: boolean, what: string, detail: unknown = '') => {
  if (!ok) failures++
  console.log((ok ? 'ok   ' : 'FAIL ') + what + (detail === '' ? '' : '  ' + JSON.stringify(detail)))
}
const rows = (spec: string): Placed[] => spec.split(' ').map((one) => ({ key: one.slice(1), group: one[0]! }))
const say = (list: Placed[]) => list.map((row) => row.group + row.key).join(' ')

const shown = rows('a1 a2 a3 b4 b5')
check(say(holdSelected(shown, rows('a1 a3 b4 b2 b5'), '2')) === 'a1 a2 a3 b4 b5', 'a selected row that changed group stays in its old group, at its old place', say(holdSelected(shown, rows('a1 a3 b4 b2 b5'), '2')))
check(say(holdSelected(shown, rows('a1 a3 b4 b2 b5'), null)) === 'a1 a3 b4 b2 b5', 'with nothing selected, the list re-sorts')
check(say(holdSelected(shown, rows('a1 a3 b4 b2 b5'), '4')) === 'a1 a3 b4 b2 b5', 'a selected row that did not move stays put, and the rest re-sort')
check(say(holdSelected(shown, rows('a9 a1 a3 a2 b4 b5'), '2')) === 'a9 a2 a1 a3 b4 b5', 'a new row above: the selected row keeps its index in its group')
check(say(holdSelected(shown, rows('a1 a3 b4 b5'), '2', { key: '2', group: 'c' })) === 'a1 a2 a3 b4 b5', 'a selected row that left the list stays, as it is now, where it was')
check(say(holdSelected(rows('a1 b2 c3'), rows('a1 c3 c2'), '2')) === 'a1 b2 c3', 'its group, gone from the list, comes back where it was')
check(say(holdSelected(rows('a1 a2'), rows('a2 a1'), '2')) === 'a1 a2', 'within one group, a re-sort leaves the selected row at its index')
if (failures) {
  console.log(failures + ' failed')
  process.exit(1)
}
console.log('all passed')

// Read state against a stale count (src/data/unread.ts): a GET /unread asked for before a mark lands
// after it, and must not undo it; a count after the mark still counts. The board is a stand-in whose
// answers come when the check says, so the order is the one that raced in the browser.
//   node scripts/unread-check.ts
import assert from 'node:assert/strict'
import { Rows } from '../src/data/collections.ts'
import { readState, type Unread } from '../src/data/unread.ts'
import type { BusRuntime } from '../src/data/runtime.ts'

const room = 'checks/channels'
const answers: ((answer: unknown) => void)[] = []
const answer = (unread: number, read: string, cursor: string) => answers.shift()!({ channels: unread ? [{ channel: room, unread, mentions: 0, read }] : [], threads: [], cursor })
const client = {
  url: 'http://stand-in/b/bus',
  get: () => new Promise((resolve) => answers.push(resolve)),
  post: async () => ({ channel: room, unread: 0, mentions: 0, read: '12' }),
}
const runtime = { client, hydrated: Promise.resolve(), feed: { cursor: 12, health: new Set() } } as unknown as BusRuntime
const rows = new Rows<Unread>((row) => row.key)
rows.bind({ begin() {}, write() {}, commit() {} })
const row = () => rows.get('channel:' + room)
const reads = readState(runtime, rows)
rows.apply([{ key: 'channel:' + room, kind: 'channel', channel: room, thread: null, unread: 1, mentions: 0, read: '10' }])

// A post's event asked for the counts; before they come, the channel is opened and marked read.
const stale = reads.refresh()
await reads.markRead({ channel: room })
assert.deepEqual([row()?.unread, row()?.read], [0, '12'], 'the mark zeroes it at once')
answer(1, '10', '11')
await stale
assert.deepEqual([row()?.unread, row()?.read], [0, '12'], 'a count asked for before the mark leaves the mark be')
console.log('ok   a count asked for before the mark leaves the mark be')

// Someone posts after the mark: the board counts it past the mark, and so does the app.
const after = reads.refresh()
answer(1, '12', '13')
await after
assert.deepEqual([row()?.unread, row()?.read], [1, '12'], 'a post after the mark counts')
console.log('ok   a post after the mark counts: the row is kept at the mark, not frozen at 0')

// And when the board has nothing unread there, the row goes.
const clear = reads.refresh()
answer(0, '13', '14')
await clear
assert.equal(row(), undefined, 'nothing unread: no row')
console.log('ok   nothing unread on the board: the row goes')
reads.close()

// hire_propose's choices, in node over a stand-in Board (src/harness/board.ts): a key a let-go
// seat had is never reused (its actor keeps its key and handle), a live seat's key is refused,
// and an open proposal for the same seat or role is reused.
//   node scripts/hire-check.ts
import assert from 'node:assert/strict'
import { boardTools, type SeatBoard } from '../src/harness/board.ts'

const WRITER = '# Writer\n\n\u0060\u0060\u0060json#seat@2\n' + JSON.stringify({ role: 'writer', tools: ['board'], can: { 'docs/': 'all' }, wakes: ['assigned'], budget: { month: 5, alert: 0.8 } }, null, 2) + '\n\u0060\u0060\u0060\n\n## Charter\n\nYou are {{name}}.\n\n## Hiring from this template\n\nnotes\n'

function stand(options: { actors: { id: string; handle: string }[]; hidden?: { id: string; handle: string }[]; seats: string[]; open?: { id: string; label: string; text: string }[] }) {
  const made: { docs: unknown[]; tasks: unknown[] } = { docs: [], tasks: [] }
  const board = {
    // As GET /actors answers: hidden actors (#16) only with ?hidden=true.
    actors: async (query?: { hidden?: boolean }) => ({ actors: [...options.actors, ...(query?.hidden ? (options.hidden ?? []).map((one) => ({ ...one, hidden: { by: 'workbus:user:jared', at: '' } })) : [])] }),
    docs: {
      at: async (path: string) => {
        if (path === 'org/templates/writer') return { body: WRITER }
        if (options.seats.includes(path)) return { doc: { path } }
        throw new Error('doc_not_found: no doc at ' + path)
      },
      create: async (input: unknown) => (made.docs.push(input), { proposal: { id: '100' } }),
    },
    tasks: {
      list: async (query: { label?: string; needs?: string }) => {
        if (query.needs) return { tasks: [] }
        const open = (options.open ?? []).filter((one) => !query.label || query.label === 'board.doc.proposal' || query.label === 'board.doc.proposal=' + one.label)
        return { tasks: open.map((one) => ({ message: { id: one.id, text: one.text, labels: { 'board.doc.proposal': one.label } } })) }
      },
      createMany: async (_channel: string, tasks: unknown[]) => (made.tasks.push(...tasks), { tasks: tasks.map((_t, i) => ({ id: String(200 + i) })) }),
    },
    read: async (id: string) => ({ message: { labels: { 'board.doc.proposal': (options.open ?? []).find((one) => one.id === id)?.label ?? '' } } }),
    label: async () => ({}),
  } as unknown as SeatBoard
  const tool = boardTools(() => board, { claimToken: () => 't' }).find((one) => one.name === 'hire_propose')!
  return { made, hire: async (input: Record<string, unknown>) => { const result = await tool.run(input as never, {} as never); return result.isError ? { error: result.text } : JSON.parse(result.text) } }
}
const work = { channel: 'eng/queue', tasks: [{ key: 'note', text: 'Write the note.' }] }

{
  // A let-go seat an owner hid (#16) is left out of plain GET /actors: hire_propose asks for the hidden ones too.
  const { hire } = stand({ actors: [], hidden: [{ id: 'worker:workbus-app+docs', handle: 'docs' }], seats: [] })
  const answer = await hire({ template: 'writer', key: 'docs', name: 'Nora', work })
  assert.equal(answer.path, 'org/seats/docs-2', "a hidden let-go seat's key is skipped too")
}

{
  const { made, hire } = stand({ actors: [{ id: 'worker:workbus-app+docs', handle: 'docs' }, { id: 'worker:workbus-app+docs-2', handle: 'docs-2' }], seats: [] })
  const answer = await hire({ template: 'writer', key: 'docs', name: 'Nora', work })
  assert.equal(answer.path, 'org/seats/docs-3', 'a key a let-go seat had (and the next one) is skipped')
  assert.deepEqual(answer.picked, { asked: 'docs', key: 'docs-3', why: 'docs was a seat before (its actor and handle stay its own), so this hire is docs-3' })
  assert.equal((made.docs[0] as { slug: string }).slug, 'docs-3')
  assert.match((made.docs[0] as { body: string }).body, /"handle": "docs-3"/)
  assert.equal((made.tasks[0] as { for: string }).for, 'worker:workbus-app+docs-3')
  console.log('ok: a let-go seat\'s key and handle are never reused')
}
{
  const { hire } = stand({ actors: [{ id: 'workbus:user:docs', handle: 'docs' }], seats: [] })
  assert.equal((await hire({ template: 'writer', key: 'docs', name: 'Nora' })).path, 'org/seats/docs-2', "anyone's handle counts")
  console.log("ok: anyone's handle is skipped too")
}
{
  const { hire } = stand({ actors: [], seats: ['org/seats/docs'] })
  assert.match((await hire({ template: 'writer', key: 'docs', name: 'Nora' })).error, /exists: that seat is hired already/)
  console.log("ok: a live seat's key is refused")
}
{
  const { made, hire } = stand({ actors: [], seats: [], open: [{ id: '90', label: 'new:org/seats/notes', text: '"role": "writer"' }] })
  const answer = await hire({ template: 'writer', key: 'scribe', name: 'Sam' })
  assert.equal(answer.reused, true)
  assert.equal(answer.path, 'org/seats/notes')
  assert.equal(made.docs.length, 0)
  console.log('ok: an open hire for the role is reused')
}
console.log('4 checks passed')

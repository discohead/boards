// The reconciler's rules, checked in node: the seed plans to two seats with no problems, and each
// kind of bad edit is refused with its reason, its seat left out of the plan.
//   node scripts/org-check.ts
import assert from 'node:assert/strict'
import { APP_CAN } from '../src/org/grant.ts'
import { backstopNeeded } from '../src/org/gateway.ts'
import { plan, prose, type OrgDoc, type Permission } from '../src/org/rules.ts'
import { SEED } from '../src/org/seed.ts'

// What the bus's /me answers the app: its grant, plus the board's default grant to every Worker.
const holds: Record<string, Permission[]> = { '*': ['read', 'post', 'react', 'label', 'sync'], ...(APP_CAN as Record<string, Permission[]>) }

const blocksOf = (text: string) =>
  [...text.matchAll(/^```json#([a-z]+)@(\d+)\n([\s\S]*?)^```$/gm)].map((found) => ({ schema: found[1]!, version: Number(found[2]), data: JSON.parse(found[3]!) }))
let next = 10
const docOf = (channel: string, slug: string, text: string, revision = next++): OrgDoc => ({ id: String(revision), channel, slug, title: /^# (.+)$/m.exec(text)?.[1] ?? slug, revision, text, blocks: blocksOf(text) })
const seed = () => SEED.map((doc) => docOf(doc.channel, doc.slug, doc.body))
const replace = (docs: OrgDoc[], path: string, change: (data: any) => void) =>
  docs.map((doc) => {
    if (doc.channel + '/' + doc.slug !== path) return doc
    const data = structuredClone(doc.blocks[0]!.data)
    change(data)
    return { ...doc, revision: next++, blocks: [{ ...doc.blocks[0]!, data }] }
  })
const why = (docs: OrgDoc[]) => plan(docs, holds).problems.map((problem) => problem.path + ': ' + problem.why)

let checks = 0
const check = (name: string, fn: () => void) => {
  fn()
  checks++
  console.log('ok ' + name)
}

check('the seed plans three seats, with no problems', () => {
  const planned = plan(seed(), holds)
  assert.deepEqual(planned.problems, [])
  assert.deepEqual(planned.seats.map((seat) => seat.key), ['ada', 'advisor', 'op'])
  const op = planned.seats.find((seat) => seat.key === 'op')!
  assert.equal(op.name, 'Operator')
  assert.equal(op.handle, 'op')
  assert.equal(op.team, 'eng')
  assert.deepEqual(op.tools, ['board'])
  // owned, not follow (#20); escalated: ada's holds reach it (ada escalates_to op).
  assert.deepEqual(op.rules, { dm: 'dm', mention: 'mention', assigned: 'assigned', owned: 'owned', answered: { tail: '--by worker:workbus-app+advisor --label org.answer=op' }, escalated: { tail: '--label org.escalated=op --label board.task=blocked' } })
  // Its own DM is in its narrowing (design/private-channels.md).
  assert.deepEqual(op.can['dm/op/'], ['read', 'post', 'react', 'label', 'edit'])
  // It reads the plans the advisor hands it.
  assert.deepEqual(op.can['docs/plans/'], ['read'])
  const ada = planned.seats.find((seat) => seat.key === 'ada')!
  assert.deepEqual(ada.rules, { assigned: 'assigned', ready: { ready: 'eng/queue' }, mention: 'mention', dm: 'dm', follow: 'follow' })
  assert.deepEqual(ada.tools, ['board', 'computer'])
  assert.deepEqual(ada.approve, { exec: 'approval' })
  assert.ok(ada.charter.startsWith('# Ada') && ada.charter.includes('## Charter') && !ada.charter.includes('json#seat'))
  assert.ok(ada.teamDoc?.includes('eng/queue'))
  assert.ok(ada.structure?.startsWith('# The org'))
})

check("prose drops a doc's blocks and keeps the rest", () => {
  assert.equal(prose('# A\n\n```json#seat@1\n{}\n```\n\n## Charter\n\nHi.\n'), '# A\n\n## Charter\n\nHi.')
})

check('a can wider than the app holds is refused', () => {
  assert.match(why(replace(seed(), 'org/seats/ada', (data) => (data.can['eng/'] = 'all')))[0]!, /^org\/seats\/ada: its can gives sync and manage at eng\/, more than the app holds there/)
  assert.match(why(replace(seed(), 'org/seats/ada', (data) => (data.can['finance/'] = ['read', 'edit'])))[0]!, /gives edit at finance\/, more than the app holds there \(read, post, react, label, sync\)/)
})

check('edit in org/ is refused: a seat proposes', () => {
  assert.match(why(replace(seed(), 'org/seats/ada', (data) => (data.can['org/'] = ['read', 'post', 'edit'])))[0]!, /post in org\/ but don't edit it/)
})

check('a tool not built, or not a tool, is refused; the operator keeps to board', () => {
  assert.match(why(replace(seed(), 'org/seats/ada', (data) => data.tools.push('browser')))[0]!, /the browser tool isn't built yet/)
  assert.match(why(replace(seed(), 'org/seats/ada', (data) => data.tools.push('hammer')))[0]!, /hammer isn't a tool/)
  assert.match(why(replace(seed(), 'org/seats/ada', (data) => (data.tools = ['computer'])))[0]!, /every seat has the board tool/)
  assert.match(why(replace(seed(), 'org/seats/op', (data) => data.tools.push('computer')))[0]!, /the operator only orchestrates/)
})

check('an approval kind that is no kind is refused', () => {
  assert.match(why(replace(seed(), 'org/seats/ada', (data) => (data.approve = { exec: 'Big Deal' })))[0]!, /the approval kind for exec, Big Deal, isn't a kind/)
})

check('a ready queue it can\'t read is refused', () => {
  assert.match(why(replace(seed(), 'org/seats/ada', (data) => (data.wakes = [{ ready: 'ops/queue' }])))[0]!, /wakes for ops\/queue but its can gives it no read there/)
})

check('two seats with one handle: the second is refused', () => {
  const problems = why(replace(seed(), 'org/seats/op', (data) => (data.handle = 'ada')))
  assert.equal(problems.length, 1)
  assert.match(problems[0]!, /@ada is already/)
})

check('an edge or a seat that names no seat doc is refused, and the team lends its seats no team', () => {
  const docs = replace(seed(), 'org/teams/eng', (data) => data.edges.push({ from: 'op', kind: 'reviews', to: 'grace' }))
  assert.match(why(docs)[0]!, /^org\/teams\/eng: its edge op reviews grace names grace, which has no doc in org\/seats/)
  assert.equal(plan(docs, holds).seats.find((seat) => seat.key === 'ada')!.team, null)
  assert.match(why(replace(seed(), 'org/teams/eng', (data) => data.seats.push('grace')))[0]!, /it names org\/seats\/grace, which doesn't exist/)
})

check("a seat doc with no block, or two, is refused, and the others still plan", () => {
  const docs = seed().map((doc) => (doc.slug === 'ada' ? { ...doc, blocks: [] } : doc))
  assert.match(why(docs)[0]!, /org\/seats\/ada: it has no `json#seat@1` or `json#seat@2` block/)
  assert.deepEqual(plan(docs, holds).seats.map((seat) => seat.key), ['advisor', 'op'])
})

check('a slug that is no profile key is refused', () => {
  const docs = [...seed(), docOf('org/seats', 'big_bird', SEED[3]!.body)]
  assert.match(why(docs).find((problem) => problem.includes('big_bird'))!, /a seat's slug is its key/)
})

check('the advisor: board only, its DM and dm wakes, in Core with its edges, and it assigns to the operator alone', () => {
  const planned = plan(seed(), holds)
  const advisor = planned.seats.find((seat) => seat.key === 'advisor')!
  assert.equal(advisor.name, 'Advisor')
  assert.equal(advisor.handle, 'advisor')
  assert.equal(advisor.role, 'advisor')
  assert.equal(advisor.team, 'core')
  assert.deepEqual(advisor.tools, ['board'])
  // consulted: op consults it, by a consult only.
  assert.deepEqual(advisor.rules, { dm: 'dm', mention: 'mention', consulted: { tail: '--mentions=worker:workbus-app+advisor --by worker:workbus-app+op --label org.consult=advisor' } })
  assert.deepEqual(advisor.can['dm/advisor/'], ['read', 'post', 'react', 'label', 'edit'])
  assert.deepEqual(advisor.can['docs/plans/'], ['read', 'post', 'react', 'label', 'edit'])
  assert.deepEqual(advisor.assigns, ['worker:workbus-app+op'])
  assert.ok(advisor.charter.includes('docs/plans') && advisor.charter.includes('worker:workbus-app+op'))
  // The operator stays in Engineering, the first team that names it; only the advisor may be held to whom it assigns.
  const op = planned.seats.find((seat) => seat.key === 'op')!
  assert.equal(op.team, 'eng')
  assert.equal(op.assigns, null)
  // Renamed, the operator is still the one the advisor hands to.
  const renamed = plan(replace(seed(), 'org/seats/op', (data) => (data.handle = 'ops')), holds).seats.find((seat) => seat.key === 'advisor')!
  assert.deepEqual(renamed.assigns, ['worker:workbus-app+op'])
})

check("the advisor doesn't do the work: a tool beyond board is refused", () => {
  assert.match(why(replace(seed(), 'org/seats/advisor', (data) => data.tools.push('computer')))[0]!, /^org\/seats\/advisor: the advisor thinks with the principal/)
})

check('an edge may end at the principal, and principal is no seat key', () => {
  assert.deepEqual(why(seed()), [])
  assert.match(why(replace(seed(), 'org/teams/core', (data) => data.edges.push({ from: 'op', kind: 'consults', to: 'boss' })))[0]!, /its edge op consults boss names boss, which has no doc in org\/seats \(and isn't principal\)/)
  const docs = [...seed(), docOf('org/seats', 'principal', SEED[3]!.body.replace('"handle": "ada"', '"handle": "pri"'))]
  assert.match(why(docs).find((problem) => problem.startsWith('org/seats/principal'))!, /principal is reserved/)
})

check('edges have their meaning: escalations, consults, reviews, and assigning', () => {
  const planned = plan(seed(), holds)
  const seat = (key: string) => planned.seats.find((one) => one.key === key)!
  // ada escalates_to op; op and the advisor escalate to the principal (null).
  assert.deepEqual(seat('ada').escalates, { key: 'op', actor: 'worker:workbus-app+op' })
  assert.equal(seat('op').escalates, null)
  assert.equal(seat('advisor').escalates, null)
  // Without escalates_to, a delegation routes escalations back to the delegator.
  const noEscalation = replace(seed(), 'org/teams/eng', (data) => (data.edges = data.edges.filter((edge: any) => edge.kind !== 'escalates_to')))
  assert.deepEqual(plan(noEscalation, holds).seats.find((one) => one.key === 'ada')!.escalates, { key: 'op', actor: 'worker:workbus-app+op' })
  const none = replace(seed(), 'org/teams/eng', (data) => (data.edges = []))
  assert.equal(plan(none, holds).seats.find((one) => one.key === 'ada')!.escalates, null)
  assert.ok(!('escalated' in plan(none, holds).seats.find((one) => one.key === 'op')!.rules))
  // op consults the advisor.
  assert.deepEqual(seat('op').consults, [{ key: 'advisor', handle: 'advisor', actor: 'worker:workbus-app+advisor' }])
  assert.deepEqual(seat('ada').consults, [])
  assert.deepEqual(seat('advisor').consultedBy, [{ key: 'op', handle: 'op', actor: 'worker:workbus-app+op' }])
  // reviews: op reviews ada.
  assert.deepEqual(seat('ada').reviewers, [])
  const reviewed = plan(replace(seed(), 'org/teams/eng', (data) => data.edges.push({ from: 'op', kind: 'reviews', to: 'ada' })), holds)
  assert.deepEqual(reviewed.seats.find((one) => one.key === 'ada')!.reviewers, ['op'])
  // Assigning: open, but the advisor's follows its delegation.
  assert.equal(seat('op').assigns, null)
  assert.deepEqual(seat('advisor').assigns, ['worker:workbus-app+op'])
})

check('the org-chart profile: one tree of delegations, answered when an edit breaks it', () => {
  const optIn = (docs: OrgDoc[]) => docs.map((doc) => (doc.slug === 'structure' ? { ...doc, revision: next++, blocks: [{ schema: 'org', version: 1, data: { profile: 'org-chart' } }] } : doc))
  // The seed is a tree: advisor → op → ada.
  const tree = plan(optIn(seed()), holds)
  assert.deepEqual(tree.problems, [])
  // Under the profile, every seat assigns only along its delegations.
  assert.deepEqual(tree.seats.find((one) => one.key === 'op')!.assigns, ['worker:workbus-app+ada'])
  assert.deepEqual(tree.seats.find((one) => one.key === 'ada')!.assigns, [])
  // Two delegations into ada.
  const two = why(optIn(replace(seed(), 'org/teams/eng', (data) => data.edges.push({ from: 'advisor', kind: 'delegates_to', to: 'ada' }))))
  assert.ok(two.some((problem) => /org\/teams\/eng: its delegations break the org-chart profile .*ada has two delegates_to coming in/.test(problem)), two.join('\n'))
  // A circle.
  const circle = why(optIn(replace(seed(), 'org/teams/eng', (data) => data.edges.push({ from: 'ada', kind: 'delegates_to', to: 'advisor' }))))
  assert.ok(circle.some((problem) => /go in a circle/.test(problem)), circle.join('\n'))
  // A seat with no delegation in: two roots. And its edges then do nothing.
  const hire = optIn([...seed(), docOf('org/seats', 'rel', SEED.find((doc) => doc.slug === 'ada')!.body.replace('"handle": "ada"', '"handle": "rel"'))])
  assert.ok(why(hire).some((problem) => /2 roots \(advisor and rel\)/.test(problem)), why(hire).join('\n'))
  assert.equal(plan(hire, holds).seats.find((one) => one.key === 'ada')!.escalates, null)
  // Not opted in, the same docs plan with no problem from it.
  assert.ok(!why([...seed(), docOf('org/seats', 'rel', SEED.find((doc) => doc.slug === 'ada')!.body.replace('"handle": "ada"', '"handle": "rel"'))]).some((problem) => /roots/.test(problem)))
})

check("seat@2 takes 'owned'; seat@1 and seat@2 read the same", () => {
  const v1 = seed().map((doc) => (doc.slug === 'op' ? { ...doc, blocks: doc.blocks.map((block) => ({ ...block, version: 1, data: { ...(block.data as any), wakes: ['dm'] } })) } : doc))
  assert.deepEqual(plan(v1, holds).seats.find((one) => one.key === 'op')!.rules.dm, 'dm')
  const both = seed().map((doc) => (doc.slug === 'op' ? { ...doc, blocks: [...doc.blocks, { ...doc.blocks[0]!, version: 1 }] } : doc))
  assert.match(why(both)[0]!, /has 2 `json#seat@1` or `json#seat@2` blocks/)
})

check('the revisions: the config is the newest of the seat, the teams, and the root; the wake, of the seat and the teams (their edges add rules)', () => {
  const docs = seed()
  const team = docs.find((doc) => doc.slug === 'core')!
  team.revision = 999
  const ada = plan(docs, holds).seats.find((seat) => seat.key === 'ada')!
  // Core isn't ada's team, but its edges could add to anyone's rules: an edit to it orders the next apply.
  assert.equal(ada.configRevision, 999)
  assert.equal(ada.revision, 999)
  const own = docs.find((doc) => doc.slug === 'ada')!
  own.revision = 1000
  assert.equal(plan(docs, holds).seats.find((seat) => seat.key === 'ada')!.revision, 1000)
})

check("a budget the gateway's backstop doesn't cover is a notice, not a problem", () => {
  assert.deepEqual(plan(seed(), holds).notices, [])
  const docs = replace(seed(), 'org/seats/ada', (data) => (data.budget = { month: 30, alert: 0.8 }))
  const planned = plan(docs, holds)
  assert.ok(planned.seats.some((seat) => seat.key === 'ada'), 'it still applies')
  assert.equal(planned.problems.length, 0)
  assert.match(planned.notices[0]!.why, /needs a gateway backstop of \$38, more than the \$25 its rule seat-ada allows/)
  assert.match(backstopNeeded('rel', 21)!, /more than the \$25 its shared rule, seat-any, allows/)
  assert.equal(backstopNeeded('rel', 20), null)
})

console.log(checks + ' checks passed')

// The seats (design/workbus.md §5, §6.2): the sidebar's Direct messages has the operator's DM with
// its square avatar and @op, and Seats lists each seat with its live state; a seat's page shows its
// name, handle, state, charter, what it's on, its spend and its runs; pausing a seat
// shows on the sidebar and the page within a poll; A offers the seats, and assigning to one lands
// on the board as its actor; a task held for an approval shows the ApprovalCard, and Approve and
// Decline answer it with their decision. Only the operator's one run needs a model (DM it once before);
// the seat's state is set as the reconciler sets it, and the holds are written over the bus's API as a seat's tools write them (seats/session.ts).
import { hydrated, until } from '../lib.mjs'

const APP = 'worker:workbus-app'
const bt3 = '\u0060\u0060\u0060'

export async function run({ page, base, owner, run: id, channel, must, step }) {
  await page.goto(base + '/')
  await hydrated(page)
  const nav = page.getByRole('navigation')

  // The operator's DM: dm/op, a square (agent) avatar, the seat's name, and @op.
  const dm = nav.locator('[data-testid=dms] a[data-seat=op]')
  await must("Direct messages has the operator's DM", await until(async () => (await dm.count()) === 1, 15_000))
  const dmText = await dm.innerText()
  await step('it reads Operator and @op, and opens dm/op', dmText.includes('Operator') && dmText.includes('@op') && (await dm.getAttribute('href')) === '/c/dm/op', dmText)
  await step('with a square agent avatar', (await dm.locator('[data-slot=avatar]').getAttribute('data-kind')) === 'agent')

  // Seats: Ada, with a live state from her Seat.
  const ada = nav.locator('[data-testid=seats] a[data-seat=ada]')
  await must('Seats lists Ada', await until(async () => (await ada.count()) === 1, 10_000))
  const state = await ada.getAttribute('data-state')
  await step("with her Seat's state, through the system's SeatState", ['active', 'working', 'waiting', 'paused', 'over_budget'].includes(state) && (await ada.locator('[data-slot=seat-state]').getAttribute('data-state')) === state, state)
  await step('and a square agent avatar', (await ada.locator('[data-slot=avatar]').getAttribute('data-kind')) === 'agent')

  // Her page.
  await ada.click()
  const seat = page.getByTestId('seat')
  await must('her page opens at /seats/ada', await until(async () => page.url().endsWith('/seats/ada') && (await seat.isVisible())), page.url())
  const text = await seat.innerText()
  await step('it shows her name, @ada, and her state', (await page.getByTestId('list-pane').locator('h1').first().innerText()) === 'Ada' && text.includes('@ada') && (await seat.locator('[data-slot=seat-state]').count()) === 1, text.slice(0, 120))
  const status = await (await fetch(base + '/dev/seat', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ seat: 'ada', call: 'status' }) })).json()
  const charter = (await owner.get('/docs?path=org/seats/ada')).body ?? ''
  const prose = charter.replace(/^```json#[\s\S]*?^```$/gm, '')
  const firstLine = prose.split('\n').find((line) => line.trim() && !line.startsWith('#'))?.trim() ?? ''
  await step("her charter: her seat doc's prose", firstLine.length > 0 && (await page.getByTestId('charter').innerText()).includes(firstLine.slice(0, 40)), firstLine)
  const shownCost = Number(await page.getByTestId('spend').getAttribute('data-cost'))
  await step("her spend this period: her Seat's total", Math.abs(shownCost - (status.spend?.cost ?? 0)) < 1e-9 && (await page.getByTestId('spend').innerText()).includes('$'), { shown: shownCost, seat: status.spend })
  const runs = status.runs?.length ?? 0
  await step('her runs, as her Seat lists them', runs === 0 ? (await seat.innerText()).includes('No runs yet') : (await page.locator('[data-testid=runs] tbody tr').count()) === runs, { runs })

  // A seat that has run (the operator, after one DM, the only model call this needs): its runs and its cost, as its Seat has them.
  const opStatus = await (await fetch(base + '/dev/seat', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ seat: 'op', call: 'status' }) })).json()
  if (opStatus.runs?.length) {
    await page.goto(base + '/seats/op')
    await until(() => seat.isVisible(), 10_000)
    const rows = page.locator('[data-testid=runs] tbody tr')
    await step("the operator's page lists its runs, as its Seat does", await until(async () => (await rows.count()) === opStatus.runs.length), { shown: await rows.count(), seat: opStatus.runs.length })
    const first = await rows.first().innerText()
    await step('each with its operation, outcome, cost, and time', first.includes('#' + opStatus.runs[0].thread) && first.includes(opStatus.runs[0].outcome) && first.includes('$') && /steps/.test(first), first.replace(/\s+/g, ' '))
    await step("and its spend this period is the Seat's total", Math.abs(Number(await page.getByTestId('spend').getAttribute('data-cost')) - opStatus.spend.cost) < 1e-9, opStatus.spend)
    await ada.click()
    await until(() => page.url().endsWith('/seats/ada'))
  } else await step('a seat with runs to show (DM the operator once first)', false, 'the operator has no runs yet')

  // Paused: her Seat's own state changes, and the sidebar and her page show it within a poll. Set
  // through the dev door (/dev/seat configure), as the reconciler applies a paused seat doc: an edit
  // to her doc would also wake her (she follows it), and that's a model call.
  const dev = async (call, args = []) => (await fetch(base + '/dev/seat', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ seat: 'ada', call, args }) })).json()
  const held = await dev('status')
  await dev('configure', [{ ...held.runtime, state: 'paused' }, held.revision])
  await step('paused: the sidebar shows paused', await until(async () => (await ada.getAttribute('data-state')) === 'paused', 15_000), await ada.getAttribute('data-state'))
  await step('and so does her page', (await seat.getAttribute('data-state')) === 'paused' && /paused/.test(await seat.locator('[data-slot=seat-state]').innerText()))
  await dev('configure', [held.runtime, held.revision])
  await step('active again, the same way', await until(async () => (await ada.getAttribute('data-state')) !== 'paused', 15_000), await ada.getAttribute('data-state'))

  // A offers the seats: a task of the owner's, assigned to Ada, is hers on the board.
  const task = (await owner.post('/tasks', { channel, text: 'Bump the canary to 5% ' + id })).task.id
  await page.goto(base + '/?thread=' + task)
  await hydrated(page)
  await until(() => page.getByTestId('thread-pane').isVisible())
  await page.getByTestId('thread-title').click()
  await page.keyboard.press('a')
  const list = page.getByTestId('assign-list')
  await must('A opens Assign', await until(() => list.isVisible()))
  const offered = await list.innerText()
  await step('it offers the seats (Ada, Operator) and the principal', offered.includes('Ada') && offered.includes('Operator') && offered.includes('@ada') && offered.includes('@op'), offered.replace(/\n+/g, ' | '))
  await list.locator('[data-assignee="' + APP + '+ada"]').click()
  await step('choosing Ada assigns it to worker:workbus-app+ada on the board', await until(async () => (await owner.get('/messages/' + task + '?limit=1')).message.task.for === APP + '+ada'))

  // A task held for an approval, as Ada's exec tool holds one: the ApprovalCard, and Approve answers it.
  const heldTask = async (what) => {
    const made = (await owner.post('/tasks', { channel, text: what + ' ' + id })).task.id
    await owner.post('/tasks/' + made + '/block', { reason: 'Approve or deny exec for @ada', kind: 'approval' })
    return made
  }
  const approveMe = await heldTask('Run the migration')
  await page.goto(base + '/?thread=' + approveMe)
  await hydrated(page)
  const card = page.locator('[data-slot=approval-card]')
  await must('a task held for an approval shows the ApprovalCard', await until(() => card.isVisible(), 10_000))
  await step('"Ada wants to run exec.", with Approve ⌘↵ and Decline', (await until(async () => (await card.innerText()).includes('Ada wants to run exec.'), 10_000)) && (await card.getByRole('button', { name: /Approve/ }).innerText()).includes('⌘↵') && (await card.getByRole('button', { name: 'Decline' }).count()) === 1, (await card.innerText()).replace(/\n+/g, ' | '))
  await card.getByRole('button', { name: /Approve/ }).click()
  const answerOf = async (task) => (await owner.get('/messages/' + task + '?limit=1')).message.task
  let answered = null
  await step('Approve unblocks it with the decision approved', await until(async () => (answered = await answerOf(approveMe)).answer?.decision === 'approved' && answered.state !== 'blocked'), answered)
  await step('and the card goes', await until(async () => (await card.count()) === 0))

  const declineMe = await heldTask('Drop the old table')
  await page.goto(base + '/?thread=' + declineMe)
  await hydrated(page)
  await until(() => card.isVisible(), 10_000)
  await card.getByRole('button', { name: 'Decline' }).click()
  await step('Decline hands it back with the decision declined', await until(async () => (answered = await answerOf(declineMe)).answer?.decision === 'declined' && answered.state !== 'blocked'), answered)

  // The held call as a seat's session writes it: its thread and its input show on the card.
  const asked = (await owner.post('/tasks', { channel, text: '@ada asks to run exec in #' + approveMe + ':\n\n' + bt3 + 'json\n{\n "command": "echo ' + id + '"\n}\n' + bt3 })).task.id
  await owner.post('/tasks/' + asked + '/block', { reason: 'Approve or deny exec for @ada', kind: 'approval' })
  await page.goto(base + '/?thread=' + asked)
  await hydrated(page)
  await until(() => card.isVisible(), 10_000)
  await step('the card says where and what: "In #<thread>: <its input>"', await until(async () => (await card.innerText()).includes('In #' + approveMe + ': echo ' + id + '.'), 10_000), (await card.innerText()).replace(/\n+/g, ' | '))
  await card.getByRole('button', { name: 'Decline' }).click()

  // ⌘↵ on an open thread (not the inbox, whose ⌘↵ is its selected item's) approves.
  const keyMe = await heldTask('Rotate the keys')
  await page.goto(base + '/tasks?thread=' + keyMe)
  await hydrated(page)
  await until(() => card.isVisible(), 10_000)
  await page.getByTestId('thread-title').click()
  await page.keyboard.press('Meta+Enter')
  await step('⌘↵ approves it', await until(async () => (await answerOf(keyMe)).answer?.decision === 'approved'))
}

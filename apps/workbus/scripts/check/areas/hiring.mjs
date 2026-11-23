// Hiring in the inbox (design/workbus.md §5.7): a new-doc proposal for a seat in org/seats shows in
// the inbox as a new seat, its thread shows the seat doc it would create, and Apply creates it; the
// reconciler provisions the seat. Then letting it go: deleting its seat doc removes its wake and
// retires its Seat, and its history stays. The proposal is made over the API as the owner, narrowed
// to post in org/ (as the operator makes one), so no model is called for it; the new seat's
// introduction is one Haiku turn, so this area runs only when --only names it.
import { hydrated, until } from '../lib.mjs'

export async function run({ page, base, owner, run: id, must, step }) {
  const key = 'h' + id.replace(/[^a-z0-9]/g, '').slice(0, 6)
  const writer = (await owner.get('/docs?path=org/templates/writer')).body
  const body = writer
    .replace(/^# Writer/m, '# Hal')
    .replace('"role": "writer",', '"role": "writer",\n  "name": "Hal",\n  "handle": "' + key + '",')
    .replace(/\{\{name\}\}/g, 'Hal')
    .replace(/\n## Hiring from this template[\s\S]*$/, '\n')
  const proposal = (await owner.post('/docs', { channel: 'org/seats', slug: key, body, propose: true, note: 'A check of hiring in the inbox (run ' + id + ').' }, { 'x-board-can': 'org/=read,post' })).proposal
  await must('the proposal is a task labeled board.doc.proposal=new:org/seats/' + key, proposal.labels['board.doc.proposal'] === 'new:org/seats/' + key, proposal.labels)

  await page.goto(base + '/', { timeout: 60_000 })
  await hydrated(page)
  const row = page.locator('[data-testid=inbox] [data-item="' + proposal.id + '"]')
  await must('the inbox lists it', await until(async () => (await row.count()) === 1, 20_000))
  const text = (await row.innerText()).replace(/\n+/g, ' | ')
  await step('as a proposal of a new seat, with its path', /proposal/i.test(text) && text.includes('proposes a new seat, org/seats/' + key), text)
  await row.click()
  const pane = page.getByTestId('thread-pane')
  await step('its thread shows the seat doc it would create: the block and the charter', await until(async () => { const shown = await pane.innerText().catch(() => ''); return shown.includes('"handle": "' + key + '"') && shown.includes('You are Hal') }, 15_000), (await pane.innerText().catch(() => '')).slice(0, 300))
  // The thread pane's Task face has the task's actions; on a proposal, Complete reads Apply.
  await pane.getByRole('tab', { name: /^Task/ }).or(pane.getByText(/^Task$/)).first().click()
  const apply = pane.getByRole('button', { name: /^Apply/ }).first()
  await must('it has Apply', await until(() => apply.isVisible(), 10_000))
  await apply.click()
  const made = await until(async () => { try { return Boolean((await owner.get('/docs?path=org/seats/' + key)).doc) } catch { return false } }, 20_000)
  await step('Apply creates org/seats/' + key + ', as the principal, proposed by the owner narrowed', made)
  const seat = async () => { const response = await page.request.get(base + '/api/seats/' + key); return response.ok() ? response.json() : null }
  const provisioned = await until(async () => (await seat())?.runtime?.key === key, 30_000)
  await step('the reconciler provisions the seat: its Seat holds its config', provisioned)
  const wakeOf = async () => (await owner.get('/wakes')).wakes.find((wake) => wake.key === 'seat.' + key)
  await step('and its wake, as the seat', (await wakeOf())?.actor === 'worker:workbus-app+' + key)
  // Its introduction (one model turn) comes before it's let go, so the check doesn't race it.
  await until(async () => ((await seat())?.queue?.done ?? 0) >= 1, 60_000)

  // Letting it go: its seat doc deleted.
  const doc = (await owner.get('/docs?path=org/seats/' + key)).doc
  await owner.post('/messages/' + doc.id + '/delete', {})
  await step('deleting its seat doc removes its wake', await until(async () => !(await wakeOf()), 30_000))
  await step('and retires its Seat (its status answers no seat)', await until(async () => (await seat()) === null, 15_000))
  const history = (await owner.get('/messages?channel=dm/' + key + '&limit=20')).messages ?? []
  await step('its history stays: its introduction in its DM', history.some((message) => message.by.actor === 'worker:workbus-app+' + key), history.length)
}

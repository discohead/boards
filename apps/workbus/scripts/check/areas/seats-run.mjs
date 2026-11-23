// A seat's approval end to end, with a model (Haiku: a few cents' worth), so it's only run when asked
// (--only seats-run): a task for Ada in eng/queue asks her to run a command; her exec is held for
// the principal (seats/session.ts), her state shows waiting, the inbox shows the held task and the
// thread pane its ApprovalCard ("Ada wants to run exec."); Approve answers it, her parked session
// goes on, and the task completes; her page then shows the runs and what they cost.
import { hydrated, until } from '../lib.mjs'

export async function run({ page, base, owner, run: id, step, must }) {
  const nav = page.getByRole('navigation')
  const ada = nav.locator('[data-testid=seats] a[data-seat=ada]')
  const dev = async (call) => (await fetch(base + '/dev/seat', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ seat: 'ada', call }) })).json()
  const before = await dev('status')
  await page.goto(base + '/')
  await hydrated(page)
  // Her session holds the exec as a task of its own (the approval), in the work's thread. One already
  // waiting (an earlier run that stopped short) is answered here rather than paying for another.
  const pending = (status) => status.holds.filter((hold) => hold.state === 'held')
  let hold = pending(before)[0]
  let work = hold?.thread
  if (!hold) {
    work = (await owner.post('/tasks', { channel: 'eng/queue', text: 'Run the command \'echo ' + id + '\' with exec in your workspace, then complete this task with what it printed.', for: 'worker:workbus-app+ada' })).task.id
    await until(async () => (hold = pending(await dev('status')).find((one) => one.thread === work)), 120_000)
  }
  await must('the seat holds its exec for the principal: a task of its own, held for approval', !!hold && (await owner.get('/messages/' + hold.task + '?limit=1')).message.task.blocked?.kind === 'approval', hold)
  const task = hold.task
  await step('the sidebar shows Ada waiting', await until(async () => (await ada.getAttribute('data-state')) === 'waiting', 15_000), await ada.getAttribute('data-state'))
  const item = page.locator('[data-testid=inbox] [data-item="' + task + '"]')
  await step('the inbox shows the held task, an approval', await until(async () => /approval/i.test(await item.innerText()), 10_000), await item.innerText().catch(() => ''))
  await item.click()
  const card = page.locator('[data-slot=approval-card]')
  await must('its ApprovalCard shows in the thread pane', await until(() => card.isVisible(), 10_000))
  await step('"Ada wants to run exec."', (await card.innerText()).includes('Ada wants to run exec.'), (await card.innerText()).replace(/\n+/g, ' | '))
  await card.getByRole('button', { name: /Approve/ }).click()
  await step('Approve answers it with the decision approved', await until(async () => (await owner.get('/messages/' + task + '?limit=1')).message.task.answer?.decision === 'approved'))
  await step('her parked session goes on, and the work completes', await until(async () => (await owner.get('/messages/' + work + '?limit=1')).message.task.state === 'completed', 180_000), (await owner.get('/messages/' + work + '?limit=1')).message.task)
  // Her Seat records the run once the operation ends, a moment after the task completes.
  await until(async () => (await dev('status')).runs.length > before.runs.length, 30_000)
  const after = await dev('status')
  await ada.click()
  await until(() => page.getByTestId('seat').isVisible())
  const rows = page.locator('[data-testid=runs] tbody tr')
  await step("her page lists the new runs, as her Seat does", after.runs.length > before.runs.length && (await until(async () => (await rows.count()) === after.runs.length)), { before: before.runs.length, after: after.runs.length })
  await step('and her spend went up by their cost', await until(async () => Math.abs(Number(await page.getByTestId('spend').getAttribute('data-cost')) - after.spend.cost) < 1e-9) && after.spend.cost > before.spend.cost, { before: before.spend.cost, after: after.spend.cost })
}

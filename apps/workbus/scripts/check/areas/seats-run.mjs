// A seat's approval end to end, with a model (Haiku: a few cents' worth), so it's only run when asked
// (--only seats-run): a task for Ada in eng/queue asks her to run a command; her exec is held for
// the principal (seats/session.ts), her state shows waiting, the inbox shows the held task and the
// thread pane its ApprovalCard ("Ada wants to run exec."); Approve answers it, her parked session
// goes on, and the task completes; her page then shows the runs and what they cost.
import { hydrated, until } from '../lib.mjs'

export async function run({ page, base, owner, run: id, step, must }) {
  const nav = page.getByRole('navigation')
  const ada = nav.locator('[data-testid=seats] a[data-seat=ada]')
  // Her Seat's status: GET /api/seats/ada, which the app serves in dev and behind Access alike.
  const dev = async () => page.context().request.get(base + '/api/seats/ada', { timeout: 10_000 }).then((answer) => answer.json())
  const before = await dev('status')
  await page.goto(base + '/')
  await hydrated(page)
  // Her session holds the exec as a task of its own (the approval), in the work's thread. One already
  // waiting (an earlier run that stopped short) is answered here rather than paying for another.
  const pending = (status) => status.holds.filter((hold) => hold.state === 'held')
  let hold = pending(before)[0]
  let work = hold?.thread
  if (!hold) {
    work = (await owner.post('/tasks', { channel: 'eng/queue', text: 'Run one exec whose module returns the string ' + id + ' (export default () => "' + id + '"), then complete this task with what it returned. Nothing else.', for: 'worker:workbus-app+ada' })).task.id
    await until(async () => (hold = pending(await dev('status')).find((one) => one.thread === work)), 120_000)
  }
  await must('the seat holds its exec for the principal: a task of its own, held for approval', !!hold && (await owner.get('/messages/' + hold.task + '?limit=1')).message.task.blocked?.kind === 'approval', hold)
  const task = hold.task
  const waiting = await until(async () => (await ada.getAttribute('data-state')) === 'waiting', 90_000)
  await step('the sidebar shows Ada waiting', waiting, waiting ? 'waiting' : 'Ada not shown waiting after 90 s: ' + (await ada.getAttribute('data-state')))
  const item = page.locator('[data-testid=inbox] [data-item="' + task + '"]')
  const shownInInbox = await until(async () => /approval/i.test(await item.innerText()), 90_000)
  await step('the inbox shows the held task, an approval', shownInInbox, shownInInbox ? await item.innerText() : 'no approval for #' + task + ' in the inbox after 90 s')
  await item.click()
  const card = page.locator('[data-slot=approval-card]')
  await must('its ApprovalCard shows in the thread pane', await until(() => card.isVisible(), 10_000))
  await step('"Ada wants to run exec."', (await card.innerText()).includes('Ada wants to run exec.'), (await card.innerText()).replace(/\n+/g, ' | '))
  await card.getByRole('button', { name: /Approve/ }).click()
  await step('Approve answers it with the decision approved', await until(async () => (await owner.get('/messages/' + task + '?limit=1')).message.task.answer?.decision === 'approved'))
  await step('her parked session goes on, and the work completes', await until(async () => (await owner.get('/messages/' + work + '?limit=1')).message.task.state === 'completed', 180_000), (await owner.get('/messages/' + work + '?limit=1')).message.task)
  // Her Seat records the run once the operation ends, a moment after the task completes.
  await until(async () => (await dev('status')).spend.runs > before.spend.runs, 90_000)
  const after = await dev('status')
  await ada.click()
  await until(() => page.getByTestId('seat').isVisible())
  const rows = page.locator('[data-testid=runs] tbody tr')
  // Her Seat lists its last 20 runs: the new ones are those it didn't list before, each a row here.
  const fresh = after.runs.filter((one) => !before.runs.some((had) => had.id === one.id)).map((one) => one.id)
  await step('her page lists the new runs, as her Seat does', after.spend.runs > before.spend.runs && fresh.length > 0 && (await until(async () => (await Promise.all(fresh.map((one) => page.locator('[data-testid=runs] [data-run="' + one + '"]').count()))).every((n) => n === 1))), { fresh, spendRuns: [before.spend?.runs, after.spend?.runs] })
  await step('and her spend went up by their cost', await until(async () => Math.abs(Number(await page.getByTestId('spend').getAttribute('data-cost')) - after.spend.cost) < 1e-9) && after.spend.cost > before.spend.cost, { before: before.spend.cost, after: after.spend.cost })
}

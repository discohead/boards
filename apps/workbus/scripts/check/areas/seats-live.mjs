// The seats on a deployed app, as the principal (design/workbus.md §12's run, from the shell): the
// sidebar's dm/op and seats with the states their Seats report (GET /api/seats/<key>); Ada's page
// with her runs and spend; then one small live run with a model: a DM to @op that ends with Ada's
// exec held for approval, the inbox's ApprovalCard approved in the UI, Ada's state going waiting,
// working, then active, and her runs and spend going up. Last, no task this run made is left ready.
// Only when asked: --only seats-live (Haiku, a few cents).
import { hydrated, until } from '../lib.mjs'

export async function run({ page, base, owner, run: id, step, must }) {
  const status = async (key) => {
    const answer = await page.evaluate(async (url) => (await fetch(url)).json(), base + '/api/seats/' + key)
    if (answer.error) throw new Error('/api/seats/' + key + ': ' + answer.error)
    return answer
  }
  await page.goto(base + '/')
  await hydrated(page)
  const nav = page.getByRole('navigation')
  const dm = nav.locator('[data-testid=dms] a[data-seat=op]')
  await must("the sidebar has the operator's DM, dm/op, @op", await until(async () => (await dm.count()) === 1 && (await dm.innerText()).includes('@op'), 15_000))
  const seatRow = (key) => nav.locator('[data-testid=seats] a[data-seat=' + key + ']')
  for (const key of ['op', 'ada']) {
    const live = await status(key)
    await step('Seats lists ' + key + ' with its Seat\'s state', await until(async () => (await seatRow(key).getAttribute('data-state')) === (await status(key)).state, 12_000), { shown: await seatRow(key).getAttribute('data-state'), seat: live.state })
  }

  const before = await status('ada')
  await seatRow('ada').click()
  const seat = page.getByTestId('seat')
  await must('/seats/ada opens', await until(() => seat.isVisible(), 10_000))
  const rows = page.locator('[data-testid=runs] tbody tr')
  await step("her page lists her runs, as her Seat does", await until(async () => (await rows.count()) === before.runs.length), { shown: await rows.count(), seat: before.runs.length })
  await step('and her spend this period', await until(async () => Math.abs(Number(await page.getByTestId('spend').getAttribute('data-cost')) - (before.spend?.cost ?? 0)) < 1e-9), before.spend)

  // One live run: the principal asks the operator, the operator gives Ada a task, Ada's exec is held.
  const holdsBefore = new Set(before.holds.map((hold) => hold.task))
  const asked = (await owner.post('/messages', { channel: 'dm/op', text: 'Make one task in eng/queue for @ada: run the command echo ' + id + ' with exec in her workspace, then complete the task with what it printed. Nothing else.' })).message.id
  const states = []
  const watch = setInterval(async () => {
    const shown = await seatRow('ada').getAttribute('data-state').catch(() => null)
    if (shown && states.at(-1) !== shown) states.push(shown)
  }, 250)
  try {
    let hold = null
    await must('Ada\'s exec is held for approval', await until(async () => (hold = (await status('ada')).holds.find((one) => one.state === 'held' && !holdsBefore.has(one.task))), 240_000, 2_000), { asked })
    await step('her state shows waiting', await until(async () => (await seatRow('ada').getAttribute('data-state')) === 'waiting', 15_000), states)
    await page.goto(base + '/')
    await hydrated(page)
    const item = page.locator('[data-testid=inbox] [data-item="' + hold.task + '"]')
    await must('the inbox shows it, an approval', await until(async () => /approval/i.test(await item.innerText()), 15_000))
    await item.click()
    const card = page.locator('[data-slot=approval-card]')
    await must('its ApprovalCard shows', await until(() => card.isVisible(), 10_000))
    await step('"Ada wants to run exec.", with where and what', await until(async () => /Ada wants to run exec\.[\s\S]*In #\d+:/.test(await card.innerText()), 10_000), (await card.innerText()).replace(/\n+/g, ' | '))
    await card.getByRole('button', { name: /Approve/ }).click()
    await step('Approve lands approved on the board', await until(async () => (await owner.get('/messages/' + hold.task + '?limit=1')).message.task.answer?.decision === 'approved'), hold)
    await step('her work completes', await until(async () => (await owner.get('/messages/' + hold.thread + '?limit=1')).message.task?.state === 'completed', 240_000, 2_000), (await owner.get('/messages/' + hold.thread + '?limit=1')).message.task)
    await step('and she is active again', await until(async () => (await seatRow('ada').getAttribute('data-state')) === 'active', 60_000), states)
    await step('her state went waiting, then working, then active', states.join(' ').includes('waiting') && states.indexOf('working', states.lastIndexOf('waiting')) > 0 && states.at(-1) === 'active', states)
    const after = await status('ada')
    await seatRow('ada').click()
    await until(() => seat.isVisible(), 10_000)
    await step('her page lists the new runs', after.runs.length > before.runs.length && (await until(async () => (await rows.count()) === after.runs.length)), { before: before.runs.length, after: after.runs.length })
    await step('and her spend went up by their cost', (after.spend?.cost ?? 0) > (before.spend?.cost ?? 0) && (await until(async () => Math.abs(Number(await page.getByTestId('spend').getAttribute('data-cost')) - after.spend.cost) < 1e-9)), { before: before.spend?.cost, after: after.spend?.cost })
  } finally {
    clearInterval(watch)
  }
  // Nothing this run made is left ready.
  const made = async () => (await owner.get('/tasks?channel=eng/&state=open&limit=200')).tasks.map((row) => row.message).filter((message) => Number(message.id) > Number(asked))
  const ready = (await made()).filter((one) => one.task.state === 'ready')
  for (const message of ready) await owner.post('/tasks/' + message.id + '/complete', { result: 'answered from the inbox in a live check' })
  const left = (await made()).filter((one) => one.task.state === 'ready')
  await step('no task this run made is left ready', left.length === 0, { completedByOwner: ready.map((one) => one.id), left: left.map((one) => one.id) })
}

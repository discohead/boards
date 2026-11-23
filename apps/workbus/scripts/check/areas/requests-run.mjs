// A request with the seats at work (Haiku, a few cents; only --only requests-run): the principal asks
// the operator in its DM for one small task for Ada; the operator makes it, Ada does it, and every
// write carries org.request=<the DM message's ID>. The DM shows "What happened with this"; the request
// page lists the steps in order (asked, the task made for @ada, taken, completed), with the work's
// state and what the runs cost; nothing it made is left ready. Locally or live: it reads the seats
// through GET /api/seats/<key>, and first checks that they run the request-stamping code.
import { hydrated, until } from '../lib.mjs'

const CODE = process.env.WORKBUS_SEAT_CODE ?? 'request-2026-11-23.2'

export async function run({ page, base, owner, run: id, step, must }) {
  const status = async (key) => (await page.context().request.get(base + '/api/seats/' + key, { timeout: 10_000 })).json()
  await page.goto(base + '/')
  await hydrated(page)
  for (const key of ['op', 'ada']) {
    const seat = await status(key)
    await must(key + "'s Seat runs the request-stamping code (" + CODE + ')', seat.code === CODE, seat.code)
  }
  const short = id.toLowerCase().replace(/[^a-z0-9]/g, '').slice(-6)
  const R = (await owner.post('/messages', { channel: 'dm/op', text: 'Make exactly one task, in eng/queue, for @ada: write the doc eng/hello-' + short + ' whose body is the one line "hello ' + short + '", then complete the task. Nothing else, and no other tasks. (' + id + ')' })).message.id
  const stamped = async () => (await owner.get('/tasks?state=all&label=' + encodeURIComponent('org.request=' + R) + '&limit=50')).tasks.map((row) => row.message)
  let work = null
  await must('the operator makes a task for Ada, stamped org.request=' + R, await until(async () => (work = (await stamped()).find((one) => one.task.for === 'worker:workbus-app+ada')), 180_000, 2_000), { R })
  await step('Ada does it: the task completes', await until(async () => (await owner.get('/messages/' + work.id + '?limit=1')).message.task.state === 'completed', 240_000, 2_000), (await owner.get('/messages/' + work.id + '?limit=1')).message.task)
  // Her Seat records the run as its operation ends, a moment after.
  await until(async () => (await status('ada')).runs.some((run) => run.thread === work.id), 60_000, 2_000)

  await page.goto(base + '/c/dm/op')
  await hydrated(page)
  const link = page.locator('[data-message="' + R + '"] [data-testid=request-link]')
  await must('the DM shows "What happened with this" under the request', await until(async () => (await link.count()) === 1, 30_000))
  await link.click()
  const kinds = async () => page.locator('[data-testid=request-timeline] [data-entry]').evaluateAll((rows) => rows.map((row) => row.getAttribute('data-entry') + ':' + row.innerText.replace(/\s+/g, ' ')))
  let shown = []
  await step('its steps in order: asked, @op made a task for @ada, @ada took it, @ada completed it', await until(async () => {
    shown = await kinds()
    const at = (pattern) => shown.findIndex((one) => pattern.test(one))
    const asked = at(/^asked:/)
    const made = at(/^task:.*@op made a task in eng\/queue for @ada/)
    const took = at(/^claimed:.*@ada took #/)
    const done = at(/^completed:.*@ada completed #/)
    return asked === 0 && made > asked && took > made && done > took
  }, 30_000), shown)
  const facts = page.getByTestId('request-facts')
  await step('its facts: the task done, and what the runs cost, by @op and @ada', await until(async () => /tasks 1\/1 done/.test(await facts.innerText()) && Number(await facts.getAttribute('data-cost')) > 0 && /@ada/.test(await facts.innerText()) && /@op/.test(await facts.innerText()), 30_000), await facts.innerText().catch(() => ''))
  const row = page.locator('[data-testid=request-timeline] [data-entry=task]').first()
  await step("the work's state is done", (await row.locator('[data-state]').first().getAttribute('data-state')) === 'done')

  // Nothing it made is left ready.
  const left = (await stamped()).filter((one) => ['ready', 'waiting', 'claimed'].includes(one.task.state))
  for (const one of left) await owner.post('/tasks/' + one.id + '/complete', { result: 'closed by the requests-run check' }).catch(() => {})
  await step('nothing it made is left ready', (await stamped()).every((one) => !['ready', 'waiting', 'claimed'].includes(one.task.state)), { closed: left.map((one) => one.id) })
}

// Task lists and My work (design/workbus.md §9.3): a channel's queue is /tasks?channel=<path>; J/K
// move and ↵ opens the thread pane; someone else's tasks arrive live, and the selected row doesn't
// move while they change it; Complete in the pane claims and completes; the state chips filter and
// sit in the URL; New task makes a task at once; the board lays the states out; My work is what the
// owner claimed or what's for one of its profiles. Someone else writes in checks/tasks.
import { hydrated, until } from '../lib.mjs'

export async function run({ page, base, owner, other, run: id, channel, must, step }) {
  // Each run's tasks carry check=<run>, and the queue is filtered to them: the channel keeps earlier runs' tasks.
  const label = 'check=' + id
  const make = async (who, text, extra = {}) => (await who.post('/tasks', { channel, text: text + ' ' + id, labels: { check: id }, ...extra })).task.id
  const queue = (more = '') => base + '/tasks?channel=' + encodeURIComponent(channel) + '&label=' + encodeURIComponent(label) + more
  const taskOf = async (task) => (await owner.get('/messages/' + task + '?limit=1')).message.task
  const rows = page.locator('[data-testid=task-list] [data-row]')
  const ids = () => rows.evaluateAll((els) => els.map((el) => el.getAttribute('data-row')))
  const selected = () => page.locator('[data-testid=task-list] [data-row][aria-selected=true]').getAttribute('data-row')
  const groupOf = (task) =>
    page.evaluate((task) => {
      let el = document.querySelector('[data-testid=task-list] [data-row="' + task + '"]')
      while (el && !el.hasAttribute('data-group')) el = el.previousElementSibling
      return el?.getAttribute('data-group') ?? null
    }, task)

  // Three of the owner's ready tasks, newest last.
  const a = await make(owner, 'Alpha: write the runbook')
  const b = await make(owner, 'Bravo: rotate the key')
  const c = await make(owner, 'Charlie: tidy the queue')
  await page.goto(queue())
  await hydrated(page)
  await must("a channel's queue is /tasks?channel=<path>", await until(async () => (await page.getByTestId('list-pane').locator('h1').innerText()) === '#' + channel + ' queue'), await page.getByTestId('list-pane').locator('h1').innerText().catch(() => ''))
  await must('it lists the three open tasks there', await until(async () => (await rows.count()) === 3), await ids())

  // J, J, K: the selection moves, newest first. ↵ opens the pane.
  await page.keyboard.press('j')
  const first = await selected()
  await page.keyboard.press('j')
  const second = await selected()
  await page.keyboard.press('k')
  const back = await selected()
  await step('J and K move the selection, newest first', first === c && second === b && back === c, { first, second, back })
  await page.keyboard.press('Enter')
  await step('↵ opens it in the thread pane, in the URL', await until(async () => page.url().includes('thread=' + c) && (await page.getByTestId('thread-pane').isVisible())), page.url())

  // Select Bravo; someone else claims it and adds two tasks above it. It doesn't move until the selection does.
  await page.keyboard.press('j')
  await must('Bravo selected', (await selected()) === b)
  const y0 = (await page.locator('[data-testid=task-list] [data-row="' + b + '"]').boundingBox())?.y ?? null
  await other.post('/tasks/' + b + '/claim', {})
  await make(other, 'Delta: from someone else')
  await make(other, 'Echo: from someone else')
  await step("someone else's new tasks arrive live", await until(async () => (await rows.count()) === 5, 8_000), await ids())
  await until(async () => (await groupOf(b)) !== null)
  await page.waitForTimeout(400)
  const y1 = (await page.locator('[data-testid=task-list] [data-row="' + b + '"]').boundingBox())?.y ?? null
  await step('the selected row stayed where it was while it was claimed and rows came in above', y0 !== null && y0 === y1, { y0, y1 })
  await step('it is still in Ready until the selection moves', (await groupOf(b)) === 'ready', await groupOf(b))
  await page.keyboard.press('j')
  await step('once the selection moves on, it goes to Claimed', await until(async () => (await groupOf(b)) === 'claimed', 3_000), await groupOf(b))

  // Complete from the pane's Task tab: it claims, then completes.
  await page.goto(queue('&thread=' + a))
  await hydrated(page)
  await page.locator('[data-face=task]').click()
  await page.getByTestId('task-actions').getByRole('button', { name: 'Complete' }).click()
  await step('Complete in the Task tab completes it on the board', await until(async () => (await taskOf(a)).state === 'completed'), await taskOf(a))

  // The state chips, in the URL.
  await page.goto(queue())
  await hydrated(page)
  const chip = (name) => page.getByTestId('list-pane').getByRole('group', { name: 'Filter' }).getByRole('button', { name: new RegExp('^' + name) })
  await chip('Claimed').click()
  await step('the Claimed chip keeps the claimed one, in the URL', await until(async () => (await ids()).join() === b && page.url().includes('state=claimed')), { ids: await ids(), url: page.url() })
  await chip('Done').click()
  await step('the Done chip keeps the completed one', await until(async () => (await ids()).join() === a), await ids())

  // New task: made at once in this channel (without the run's label, so in the channel's whole queue).
  await page.goto(base + '/tasks?channel=' + encodeURIComponent(channel))
  await hydrated(page)
  await page.getByRole('button', { name: 'New task' }).click()
  const title = 'Foxtrot: made in the app ' + id
  await page.getByLabel('Task title').fill(title)
  await page.getByRole('button', { name: 'Make task' }).click()
  const made = page.locator('[data-testid=task-list] [data-row]', { hasText: title })
  await step('New task shows the task at once', await until(async () => (await made.count()) === 1, 3_000, 30))
  const settled = await until(async () => /^\d+$/.test((await made.getAttribute('data-row')) ?? ''))
  const madeId = await made.getAttribute('data-row')
  await step('and settles with its cursor, a ready task in this channel on the board', settled && (await owner.get('/messages/' + madeId + '?limit=1')).message.channel === channel, madeId)

  // The board by state, for this run's tasks.
  await page.goto(queue())
  await hydrated(page)
  await page.getByRole('button', { name: 'Board view' }).click()
  const columns = page.getByTestId('task-board').locator('section[data-group]')
  await step('Board view lays out a column per state', await until(async () => (await columns.evaluateAll((els) => els.map((el) => el.getAttribute('data-group')))).join() === 'ready,claimed,held,done'), await columns.evaluateAll((els) => els.map((el) => el.getAttribute('data-group'))).catch(() => []))

  // My work: one the owner claimed, one for its profile; not someone else's.
  const claimed = await make(owner, 'Golf: mine, claimed')
  await owner.post('/tasks/' + claimed + '/claim', {})
  const forMe = await make(owner, 'Hotel: for my profile', { for: owner.actor + '+reviewer' })
  const theirs = await make(other, 'India: someone else\'s')
  await page.goto(base + '/my-work?channel=' + encodeURIComponent(channel) + '&label=' + encodeURIComponent(label))
  await hydrated(page)
  await until(async () => (await ids()).includes(forMe))
  const mine = await ids()
  await step("My work: what the owner claimed and what's for its profile, not someone else's", mine.includes(claimed) && mine.includes(forMe) && !mine.includes(theirs) && !mine.includes(b), mine)
}

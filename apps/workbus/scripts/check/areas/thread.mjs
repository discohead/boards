// The thread pane (design/workbus.md §9.3): it opens from the URL with its path and title; a reply
// shows pending, then settles taking its cursor; C and A don't fire while typing in the reply; C
// makes the thread a task at once (the Task face appears), and A assigns it to one of the owner's
// profiles. Someone else starts the thread in checks/thread.
// "+ Write it up" gives the thread a body (POST /docs { re }): the Document tab opens and shows it.
import { hydrated, until, watchPending } from '../lib.mjs'

export async function run({ page, base, owner, other, run: id, channel, must, step }) {
  // A profile of the owner's to assign to: one post made as owner+reviewer.
  await owner.post('/messages', { channel, text: 'Reviewing as a profile, run ' + id }, { 'x-board-profile': 'reviewer' })
  const root = (await other.post('/messages', { channel, text: 'Can someone look at the canary? ' + id })).message
  const taskOf = async () => (await owner.get('/messages/' + root.id + '?limit=1')).message.task ?? null

  await page.goto(base + '/c/' + channel + '?thread=' + root.id)
  await hydrated(page)
  const pane = page.getByTestId('thread-pane')
  await pane.waitFor({ timeout: 30_000 }).catch(() => {})
  await must('the pane opens from the URL', await pane.isVisible())
  await step('it shows the path and cursor, and the title', await until(async () => (await pane.getByTestId('thread-path').innerText()).includes(channel + ' / #' + root.id) && (await pane.getByTestId('thread-title').innerText()).includes('canary')), await pane.getByTestId('thread-path').innerText().catch(() => ''))

  // A reply: pending at once ("sending…"), then settled, taking its cursor.
  const reply = pane.getByLabel('Reply')
  await reply.waitFor()
  const text = 'I will look at it now. ' + id
  await reply.fill(text)
  const sawPending = await watchPending(page, text)
  await reply.press('Meta+Enter')
  const mine = pane.locator('[data-testid=conversation] li', { hasText: text })
  await step('a reply shows at once, pending', await until(sawPending, 3_000, 30))
  const settled = await until(async () => (await mine.count()) === 1 && (await mine.getAttribute('data-pending')) === null && /#\d+/.test(await mine.innerText()))
  await step('and settles, taking its cursor', settled, await mine.innerText().catch(() => ''))

  // C and A while typing in the reply: nothing.
  await reply.click()
  await page.keyboard.type('Can A cat count? ca')
  await page.waitForTimeout(600)
  await step('typing C and A in the reply makes no task', (await taskOf()) === null && (await pane.getByRole('tab', { name: 'Task' }).count()) === 0 && (await reply.inputValue()).endsWith('ca'))
  await reply.fill('')

  // C, with focus out of the reply: the Task face at once, then the board's task.
  await pane.getByTestId('thread-title').click()
  await page.keyboard.press('c')
  await step('C makes it a task at once: the Task face appears', await until(() => pane.getByRole('tab', { name: 'Task' }).isVisible(), 2_000, 30))
  await step('and the board has the task', await until(async () => (await taskOf())?.state === 'ready'), await taskOf())

  // A: assign to the owner's profile.
  await pane.getByTestId('thread-title').click()
  await page.keyboard.press('a')
  const list = page.getByTestId('assign-list')
  await list.waitFor({ timeout: 5_000 }).catch(() => {})
  await page.keyboard.type('reviewer')
  await page.keyboard.press('Enter')
  await step("A assigns it to one of the owner's profiles", await until(async () => (await taskOf())?.for === owner.actor + '+reviewer'), (await taskOf())?.for)
  // The system's toast: role=status, what happened, and the cursor.
  const told = page.getByRole('status').filter({ hasText: 'Assigned to' })
  await step('and says so in a toast, with the cursor', await until(async () => (await told.last().innerText()).includes('#' + root.id), 5_000), await told.last().innerText().catch(() => ''))

  // Write it up: the add tab makes the thread a doc; the Document tab opens and shows its body.
  await pane.getByText('Write it up', { exact: false }).first().click()
  const docTab = pane.getByRole('tab', { name: 'Document' })
  await step('"Write it up" adds the Document tab and opens it', await until(async () => (await docTab.getAttribute('aria-selected')) === 'true', 10_000))
  const shown = pane.getByTestId('doc')
  await step('it shows the body', await until(async () => (await shown.innerText()).includes('canary'), 10_000), await shown.innerText().catch(() => ''))
  const written = (await owner.get('/messages/' + root.id + '?limit=1')).message
  await step('and the board has the thread as a doc', written.doc !== undefined, written.doc?.path)
}

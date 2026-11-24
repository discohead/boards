// Deleted threads, tasks, and docs on a crowded board: no list shows one, as an empty row or in a
// count. Someone else makes threads (two with the same first line), a task, a doc, a mention of the
// owner, and an unread post in a second channel; the deleted ones must be gone from ⌘K (whose rows
// stay distinct and selectable: Enter opens the top result), the task list, My work, the docs index,
// the inbox, the sidebar's unread, a request's timeline, and the channel.
import { hydrated, until } from '../lib.mjs'

export async function run({ page, base, owner, other, run: id, channel, must, step }) {
  const post = async (who, text, where = channel) => (await who.post('/messages', { channel: where, text })).message.id
  const remove = (who, messageId) => who.post('/messages/' + messageId + '/delete', {})
  const same = 'Same first line ' + id
  const first = await post(other, same + '\n\nthe first')
  const second = await post(other, same + '\n\nthe second')
  const gone = await post(other, 'To be deleted ' + id)
  await remove(other, gone)
  const task = (await other.post('/tasks', { channel, text: 'A deleted task ' + id })).task.id
  await remove(other, task)
  const mine = (await owner.post('/tasks', { channel, text: 'My deleted task ' + id })).task.id
  await owner.post('/tasks/' + mine + '/claim', {})
  await remove(owner, mine)
  const doc = (await owner.post('/docs', { channel: 'checks/docs', slug: 'deleted-' + id, body: '# Deleted doc ' + id + '\n' })).message.id
  await remove(owner, doc)
  const mention = await post(other, '@' + owner.handle + ' a deleted mention ' + id)
  await remove(other, mention)
  const away = channel + '-unread'
  const unread = await post(other, 'Unread, then deleted ' + id, away)
  await remove(other, unread)
  // A request: two tasks carry it, and one of them is deleted.
  const request = await post(owner, 'A request ' + id)
  const kept = (await other.post('/tasks', { channel, text: 'Work for the request ' + id, labels: { 'org.request': request } })).task.id
  const dropped = (await other.post('/tasks', { channel, text: 'Work for the request, deleted ' + id, labels: { 'org.request': request } })).task.id
  await remove(other, dropped)
  await must('someone else made and deleted them', true, { first, second, gone, task, mine, doc, mention, unread, request, kept, dropped })

  // ⌘K: the two threads are two rows, one is selected, no row is empty, and Enter opens the top one.
  await page.goto(base + '/')
  await hydrated(page)
  await until(async () => {
    await page.keyboard.press('Meta+K')
    return page.getByLabel('Command').waitFor({ timeout: 700 }).then(() => true, () => false)
  }, 15_000, 0)
  await page.keyboard.type(same)
  const rows = page.locator('[cmdk-item]')
  await until(async () => (await page.locator('[cmdk-group]', { hasText: 'Search: ' }).locator('[cmdk-item]').count()) >= 2, 8_000)
  const shown = await rows.evaluateAll((els) => els.map((el) => ({ value: el.getAttribute('data-value'), selected: el.getAttribute('data-selected') === 'true', text: el.textContent.trim() })))
  const values = shown.map((row) => row.value)
  await step('⌘K: rows with the same first line stay distinct, and none is empty', values.length === new Set(values).size && shown.every((row) => row.text !== '' && !/^#\d+$/.test(row.text)), shown.map((row) => row.text.slice(0, 50)))
  await step('⌘K: one row is selected', shown.filter((row) => row.selected).length === 1, shown.filter((row) => row.selected).map((row) => row.text.slice(0, 50)))
  await page.keyboard.press('Enter')
  await step('⌘K: Enter opens the top result', await until(async () => [first, second].some((thread) => page.url().includes('thread=' + thread)), 5_000), page.url())
  await page.keyboard.press('Meta+K')
  await page.getByLabel('Command').waitFor({ timeout: 5_000 }).catch(() => {})
  await page.keyboard.type('To be deleted ' + id)
  await page.waitForTimeout(1_200)
  await step('⌘K: a deleted thread is no result', (await page.locator('[cmdk-item]', { hasText: 'To be deleted ' + id }).count()) === 0)
  // Its root keeps its #id, and its text is gone: by the #id, it would be an empty row.
  await page.locator('[cmdk-input]').fill('#' + gone)
  await page.waitForTimeout(1_200)
  await step('⌘K: nor is it an empty row, even asked for by its #id', (await page.locator('[cmdk-item]').evaluateAll((els) => els.filter((el) => /^#\d+$/.test(el.textContent.trim())).length)) === 0)
  await page.keyboard.press('Escape')

  // The task list and My work.
  await page.goto(base + '/tasks?channel=' + encodeURIComponent(channel) + '&state=all')
  await hydrated(page)
  await page.getByTestId('list-pane').waitFor()
  await page.waitForTimeout(800)
  await step('the task list shows no deleted task', (await page.locator('[data-row="' + task + '"], [data-row="' + mine + '"]').count()) === 0)
  await page.goto(base + '/my-work')
  await hydrated(page)
  await page.waitForTimeout(800)
  await step("My work shows no deleted task of the owner's", (await page.locator('[data-row="' + mine + '"]').count()) === 0 && !(await page.locator('body').innerText()).includes('My deleted task ' + id))

  // The docs index, the inbox, the sidebar, and the channel.
  await page.goto(base + '/docs')
  await hydrated(page)
  await page.waitForTimeout(800)
  await step('the docs index shows no deleted doc', (await page.locator('[data-testid=doc-list] li[data-id="' + doc + '"]').count()) === 0 && !(await page.locator('body').innerText()).includes('Deleted doc ' + id))
  await page.goto(base + '/')
  await hydrated(page)
  await page.waitForTimeout(800)
  await step('the inbox shows no deleted mention', (await page.locator('[data-item="' + mention + '"]').count()) === 0 && !(await page.locator('body').innerText()).includes('a deleted mention ' + id))
  const link = page.getByTestId('sidebar').locator('[data-channel="' + away + '"]')
  await step('a channel whose only new post was deleted is not unread', (await link.getAttribute('data-unread').catch(() => null)) === null, await link.getAttribute('class').catch(() => 'not listed'))
  await page.goto(base + '/requests/' + request)
  await hydrated(page)
  const facts = page.getByTestId('request-facts').locator('[data-fact=tasks]')
  let seen = ''
  await step("a request's timeline doesn't count its deleted task", await until(async () => /tasks \d+\/1 done/.test((seen = await facts.innerText())), 20_000), seen)
  await page.goto(base + '/c/' + channel)
  await hydrated(page)
  await page.waitForTimeout(800)
  await step('the channel shows no deleted thread', (await page.getByTestId('threads').locator('[data-id="' + gone + '"]').count()) === 0 && (await page.getByTestId('threads').locator('[data-id="' + first + '"]').count()) === 1)
}

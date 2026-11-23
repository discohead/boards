// Channels (design/workbus.md §9.3): a post shows pending, then settles taking its cursor; someone
// else's post arrives live with its one tint; a channel someone writes in while you're elsewhere is
// bold (unread) in the sidebar, and opening it clears that; scrolled up, new posts gather behind
// the pill ("2 new"), which takes you to them.
import { hydrated, until, watchPending } from '../lib.mjs'

export async function run({ page, base, owner, other, run: id, channel, must, step }) {
  // Enough history to scroll, and a starting post so the channel is there.
  for (let n = 1; n <= 24; n++) await other.post('/messages', { channel, text: 'History ' + n + ' for the scroll, run ' + id })
  await page.goto(base + '/c/' + channel)
  await hydrated(page)
  const rows = page.getByTestId('threads').locator('[data-id]')
  const row = (text) => page.getByTestId('threads').locator('[data-id]', { hasText: text })
  await must('the channel opens with its threads', await until(async () => (await rows.count()) > 0, 15_000))

  // A post: pending at once, then settled with its cursor.
  const composer = page.getByLabel('Message #' + channel)
  const text = 'Posted in the channel, run ' + id
  await composer.fill(text)
  const sawPending = await watchPending(page, text)
  await composer.press('Enter')
  await step('a post shows at once, sending', await until(sawPending, 3_000, 30))
  const settled = await until(async () => (await row(text).getAttribute('data-pending')) === null && /^#\d+$/.test((await row(text).getByTestId('cursor').innerText()).trim()))
  await step('and settles, taking its cursor', settled, await row(text).getByTestId('cursor').innerText().catch(() => ''))
  const board = await owner.get('/threads?channel=' + encodeURIComponent(channel) + '&limit=50')
  await step('the board has it, once', board.threads.filter((t) => t.message.text === text).length === 1)

  // Someone else posts while you're here: it arrives, with the arrival tint.
  const theirs = 'From someone else, live, run ' + id
  await other.post('/messages', { channel, text: theirs })
  // The tint is on the message inside the row (threads' fc3553c moved it to [data-message]).
  const tinted = await until(async () => (await row(theirs).locator('[data-arrive="yes"]').count()) > 0, 8_000, 30)
  await step("someone else's post arrives live, tinted once", tinted)

  // Unread: while you're elsewhere, someone writes here; the sidebar's link turns bold, and opening clears it.
  const link = page.getByTestId('sidebar').locator('[data-channel="' + channel + '"]')
  await page.goto(base + '/docs')
  await hydrated(page)
  await step('it is read while you are elsewhere', (await link.getAttribute('data-unread')) === null)
  await other.post('/messages', { channel, text: 'Written while you were away, run ' + id })
  await step('a post by someone else makes it unread in the sidebar', await until(async () => (await link.getAttribute('data-unread')) === 'yes'), await link.getAttribute('class').catch(() => ''))
  await link.click()
  await step('opening the channel clears it', await until(async () => (await link.getAttribute('data-unread')) === null))

  // Scrolled up: new posts gather behind the pill, and the pill takes you to them.
  await hydrated(page)
  await page.getByTestId('history').evaluate((el) => el.scrollTo(0, 0))
  await page.waitForTimeout(400)
  await other.post('/messages', { channel, text: 'Below you one, run ' + id })
  await other.post('/messages', { channel, text: 'Below you two, run ' + id })
  const pill = page.getByTestId('new-below')
  // It counts the posts that landed below the view: at least one of the two.
  await step('scrolled up, new posts gather behind the pill', await until(async () => /^[12] new/.test((await pill.innerText()).trim()), 8_000), await pill.innerText().catch(() => ''))
  await pill.locator('button').first().click()
  const atEnd = await until(async () => (await pill.count()) === 0 && (await row('Below you two, run ' + id).isVisible()), 8_000)
  await step('the pill takes you to them, and goes', atEnd)
}

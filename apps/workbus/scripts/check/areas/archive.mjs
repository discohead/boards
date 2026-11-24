// Archived channels (issue #15): Archive from a channel's menu takes it out of the sidebar and puts
// the archived bar where the composer was; the board lists it no more and refuses posts there;
// Archived in the sidebar lists it, and Unarchive brings it back, composer and all.
import { hydrated, until } from '../lib.mjs'

export async function run({ page, base, owner, other, run: id, channel: area, must, step }) {
  const channel = area + '-' + id
  await owner.post('/messages', { channel, text: 'A thread to archive, run ' + id })
  await other.post('/messages', { channel, text: 'Someone else here too, run ' + id })
  await page.goto(base + '/c/' + channel)
  await hydrated(page)
  const link = page.getByTestId('sidebar').locator('[data-channel="' + channel + '"]')
  await must('the channel is in the sidebar', await until(async () => (await link.count()) === 1, 15_000))

  await page.getByTestId('channel-menu').click()
  await page.getByRole('menuitem', { name: 'Archive channel' }).click()
  await step('archiving takes it out of the sidebar', await until(async () => (await link.count()) === 0))
  const bar = page.getByTestId('archived-bar')
  await step('and puts the archived bar where the composer was', await until(async () => (await bar.isVisible()) && (await page.getByLabel('Message #' + channel).count()) === 0))
  const listed = async () => (await owner.get('/channels?limit=500')).channels.some((row) => row.path === channel)
  await step('the board lists it no more', !(await listed()))
  const refused = await other.post('/messages', { channel, text: 'after the archive' }).then(() => null, (error) => String(error.message ?? error))
  await step('and refuses posts there', refused !== null && /channel_archived|409/.test(refused), refused)

  await page.getByTestId('archived-link').click()
  const row = page.getByTestId('archived-channels').locator('[data-channel="' + channel + '"]')
  await must('Archived lists it', await until(async () => (await row.count()) === 1))
  await step('under its own title', (await page.getByTestId('view-title').innerText()).trim() === 'Archived')
  await row.getByRole('button', { name: 'Unarchive' }).click()
  await step('Unarchive takes it off the list', await until(async () => (await row.count()) === 0))
  await step('and back into the sidebar', await until(async () => (await link.count()) === 1))
  await step('the board lists it again', await until(listed))
  await link.click()
  await step('with its composer back', await until(async () => (await page.getByLabel('Message #' + channel).count()) === 1 && (await bar.count()) === 0))
}

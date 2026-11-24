// Moderation and hidden actors in the app (#26, #16). The owner deletes someone else's thread as
// moderation: Delete is offered on it, the confirm says its replies go with it, and the board logs
// every delete as moderation; a lone reply the same way; the owner's own message keeps the plain
// confirm. In Settings the owner hides an actor: it leaves GET /actors and @mention suggestions, its
// message keeps its author, and Show brings it back. The other writer is a profile of the app's
// that isn't a seat, so nothing wakes. Local only (WORKBUS_APP_TOKEN): --only moderation.
import { actor, hydrated, until } from '../lib.mjs'

export async function run({ page, base, board, owner, run: id, step, must, channel }) {
  const appToken = process.env.WORKBUS_APP_TOKEN
  if (!appToken) return void (await step('a workload token for workbus-app (WORKBUS_APP_TOKEN)', false))
  const key = 'mod' + id.toLowerCase().replace(/[^a-z0-9]/g, '').slice(-6)
  const other = await actor(key, { api: base + '/b/' + board, headers: { authorization: 'Bearer ' + appToken, 'x-board-profile': key + ';name="Moderated ' + key.slice(3) + '";handle="' + key + '"' } })
  const root = (await other.post('/messages', { channel, text: 'a test thread to clear ' + id })).message.id
  await owner.post('/messages', { re: root, text: 'a reply of the owner in it ' + id })
  await other.post('/messages', { re: root, text: 'and its own reply ' + id })
  const lone = (await other.post('/messages', { channel, text: 'a thread whose reply alone goes ' + id })).message.id
  const loneReply = (await other.post('/messages', { re: lone, text: 'the reply that goes ' + id })).message.id
  const mine = (await owner.post('/messages', { channel, text: "the owner's own " + id })).message.id

  await page.goto(base + '/c/' + channel)
  await hydrated(page)
  const row = (message) => page.locator('[data-message="' + message + '"]').first()
  await must("someone else's thread is in the channel", await until(async () => (await row(root).count()) === 1, 15_000))
  await row(root).hover()
  const tool = row(root).getByRole('button', { name: 'Delete as moderation' })
  await step("Delete is offered on someone else's message, as moderation", await until(() => tool.isVisible(), 5_000))
  await tool.click()
  const confirm = page.getByTestId('delete-confirm')
  await step('the confirm says its replies go with it, and that the log keeps it', /Delete this thread, as moderation\? Its replies go with it/.test(await confirm.innerText()))
  await confirm.getByRole('button', { name: 'Delete' }).click()
  await step('the board deleted the root and both replies', await until(async () => {
    const read = await owner.get('/messages/' + root)
    return read.message.deleted && read.replies.every((one) => one.deleted)
  }, 10_000))
  const deletes = (await owner.get('/events?all=true&last=20')).events.filter((event) => event.type === 'message.deleted')
  await step('each delete is logged as moderation, by the owner', deletes.length >= 3 && deletes.slice(-3).every((event) => event.payload.moderation === true && event.payload.by.actor === owner.actor), deletes.map((event) => [event.payload.id, event.payload.moderation]))
  await step('and the thread leaves the channel', await until(async () => (await row(root).count()) === 0, 10_000))

  // A lone reply, from the thread pane.
  await page.goto(base + '/c/' + channel + '?thread=' + lone)
  await hydrated(page)
  const reply = page.getByTestId('thread-pane').locator('[data-message="' + loneReply + '"]')
  await until(() => reply.isVisible(), 10_000)
  await reply.hover()
  await reply.getByRole('button', { name: 'Delete as moderation' }).click()
  await step('a reply: "Delete this message, as moderation?"', /Delete this message, as moderation\?/.test(await page.getByTestId('delete-confirm').innerText()))
  await page.getByTestId('delete-confirm').getByRole('button', { name: 'Delete' }).click()
  await step('the reply goes; its root stays', await until(async () => {
    const read = await owner.get('/messages/' + lone)
    return !read.message.deleted && read.replies.find((one) => one.id === loneReply)?.deleted === true
  }, 10_000))

  // The owner's own: the plain confirm.
  await page.goto(base + '/c/' + channel)
  await hydrated(page)
  await until(async () => (await row(mine).count()) === 1, 10_000)
  await row(mine).hover()
  await row(mine).getByRole('button', { name: 'Delete', exact: true }).click()
  await step('their own message keeps the plain confirm', (await page.getByTestId('delete-confirm').innerText()).startsWith('Delete this message?'))
  await page.keyboard.press('Escape').catch(() => {})

  // Before it's hidden, @mention offers it.
  const actorId = other.actor
  const offeredNow = async () => {
    await page.goto(base + '/c/' + channel)
    await hydrated(page)
    const box = page.getByRole('textbox').last()
    await box.click()
    await box.fill('@' + key.slice(0, 5))
    await page.waitForTimeout(800)
    const offered = await page.getByTestId('mention-list').innerText().catch(() => '')
    await box.fill('')
    return offered
  }
  await step('before it is hidden, @mention suggestions offer it', await until(async () => (await offeredNow()).includes(key), 15_000))

  // Hide the other writer in Settings.
  await page.goto(base + '/settings')
  await hydrated(page)
  const person = page.locator('[data-testid=settings-people] [data-actor="' + actorId + '"]')
  await must('Settings lists the people, the other writer among them', await until(() => person.isVisible(), 15_000))
  await person.getByRole('button', { name: 'Hide' }).click()
  await step('Hide: it leaves GET /actors', await until(async () => !(await owner.get('/actors')).actors.some((one) => one.id === actorId), 10_000))
  await step('and Settings marks it hidden', await until(async () => (await person.getAttribute('data-hidden')) === 'yes', 10_000))
  const offered = await offeredNow()
  await step('@mention suggestions leave it out', !offered.includes(key), offered)
  await step('its message keeps its author', (await owner.get('/messages/' + lone)).message.author?.handle === key)
  await page.goto(base + '/settings')
  await hydrated(page)
  await until(() => person.isVisible(), 10_000)
  await person.getByRole('button', { name: 'Show' }).click()
  await step('Show brings it back', await until(async () => (await owner.get('/actors')).actors.some((one) => one.id === actorId), 10_000))
  // Tidy: what's left of the test, gone; the actor hidden for good.
  await owner.post('/messages/' + lone + '/delete', {}).catch(() => {})
  await owner.post('/messages/' + mine + '/delete', {}).catch(() => {})
  await owner.post('/actors/hide', { actor: actorId }).catch(() => {})
}

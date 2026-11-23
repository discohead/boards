// The inbox (design/workbus.md §6.1): what's waiting on the owner. A mention from someone else
// shows live, opens in the pane, and E marks it done (read on the board): it fades while selected,
// leaves when the selection moves, and the sidebar's count drops. A task someone else holds for the
// owner shows held, with its kind, and ⌘↵ answers it. A reply in the owner's thread shows, and the
// owner's own reply answers it. A proposal shows, and Apply in the Task tab applies it. Someone else
// writes in checks/inbox.
import { hydrated, until } from '../lib.mjs'

export async function run({ page, base, owner, other, run: id, channel, must, step }) {
  const item = (thread) => page.locator('[data-testid=inbox] [data-item="' + thread + '"]')
  // The sidebar's Inbox row ends with the count (the sidebar's one brand fill).
  const count = async () => Number(/(\d+)\s*$/.exec(await page.getByRole('navigation').getByRole('link', { name: /^Inbox/ }).first().innerText().catch(() => ''))?.[1] ?? 0)
  const unreadThreads = async () => (await owner.get('/unread')).threads.map((row) => row.thread)
  const settle = (thread) => until(async () => (await item(thread).count()) === 0 || (await item(thread).getAttribute('data-gone')) === 'yes', 8_000)

  await page.goto(base + '/')
  await hydrated(page)
  await must('the inbox is there', await until(() => page.getByTestId('inbox').isVisible()))

  // A mention from someone else: live, with its kind; it opens in the pane; E marks it done.
  const mention = (await other.post('/messages', { channel, text: '@' + owner.handle + ' can you check the canary? ' + id })).message
  await step('a mention from someone else shows live', await until(async () => (await item(mention.id).count()) === 1, 8_000))
  await step('marked as a mention, with who and where', /mention/i.test(await item(mention.id).innerText()) && (await item(mention.id).innerText()).includes('@' + other.handle) && (await item(mention.id).innerText()).includes(channel), await item(mention.id).innerText().catch(() => ''))
  const before = await count()
  // The board stores the mention as @[actor id]; the row shows the handle (live, the ID's tail is an Access sub).
  const tail = owner.actor.replace(/^.*[:+]/, '')
  const asHandle = (text) => text.includes('@' + owner.handle + ' can you check') && !text.includes('@[') && (tail === owner.handle || !text.includes('@' + tail))
  let seen = ''
  await step("its row shows the mention as the owner's @handle", await until(async () => asHandle((seen = await item(mention.id).innerText())), 5_000), seen.replace(/\n+/g, ' | '))
  await item(mention.id).click()
  await step('it opens in the thread pane', await until(async () => page.url().includes('thread=' + mention.id) && (await page.getByTestId('thread-pane').isVisible())), page.url())
  await page.locator('[data-testid=inbox]').click({ position: { x: 1, y: 1 } }).catch(() => {})
  await page.keyboard.press('e')
  await step('E marks it done: it fades in place while selected', await until(async () => (await item(mention.id).getAttribute('data-gone')) === 'yes', 5_000))
  await step('and the board has the thread read', await until(async () => !(await unreadThreads()).includes(mention.id)), await unreadThreads())
  await page.keyboard.press('j')
  await step('it leaves when the selection moves, and the count drops', await until(async () => (await item(mention.id).count()) === 0 && (await count()) === before - 1, 5_000), { before, now: await count() })

  // A task someone else holds for the owner, as an approval: ⌘↵ answers it (unblock).
  const held = (await other.post('/tasks', { channel, text: 'Deploy v42 to production ' + id })).task.id
  await other.post('/tasks/' + held + '/block', { reason: 'Needs your OK to deploy', kind: 'approval' })
  await step('a task held for the owner shows live, held', await until(async () => (await item(held).getAttribute('data-kinds')) === 'held', 8_000))
  await step('with its kind', /approval/i.test(await item(held).innerText()), await item(held).innerText().catch(() => ''))
  await item(held).click()
  await page.keyboard.press('Meta+Enter')
  await step('⌘↵ answers it: the board has it unblocked', await until(async () => (await owner.get('/messages/' + held + '?limit=1')).message.task.state !== 'blocked'))
  await step('and it leaves the inbox', await settle(held))

  // A reply in the owner's thread: it shows; the owner's own reply answers it.
  const root = (await owner.post('/messages', { channel, text: 'What should the canary threshold be? ' + id })).message
  await other.post('/messages', { re: root.id, text: 'Two percent, I think. ' + id })
  await step("someone else's reply in the owner's thread shows live", await until(async () => (await item(root.id).count()) === 1, 8_000))
  await owner.post('/messages', { re: root.id, text: 'Two percent it is. ' + id })
  await step("the owner's reply answers it: read on the board, gone from the inbox", (await settle(root.id)) && !(await unreadThreads()).includes(root.id), await unreadThreads())

  // A proposal from someone else on the owner's doc: Apply in the Task tab applies it.
  const slug = 'canary-' + id.toLowerCase().replace(/[^a-z0-9]/g, '')
  const doc = (await owner.post('/docs', { channel, slug, body: '# Canary\n\n## Threshold\n\nOne percent.\n' })).message
  const read = await owner.get('/docs/' + doc.id)
  const proposal = (await other.post('/docs/' + doc.id + '/edit', { edits: [{ section: read.doc.sections.find((one) => one.key.endsWith('threshold')).key, text: 'Two percent.' }], revision: read.doc.revision, propose: true })).proposal
  await step('a proposal on the owner\'s doc shows live', await until(async () => (await item(proposal.id).getAttribute('data-kinds')) === 'proposal', 8_000), await item(proposal.id).innerText().catch(() => ''))
  await item(proposal.id).click()
  await page.getByTestId('thread-pane').getByRole('tab', { name: 'Task' }).or(page.locator('[data-face=task]')).first().click()
  await page.getByTestId('task-actions').getByRole('button', { name: 'Apply' }).click()
  await step('Apply in the Task tab applies it to the doc', await until(async () => (await owner.get('/docs/' + doc.id)).body.includes('Two percent.')))
  await step('and it leaves the inbox', await settle(proposal.id))
}

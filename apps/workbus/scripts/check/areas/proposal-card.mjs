// One proposal's card, rendered and not applied (--only proposal-card, WORKBUS_PROPOSAL=<task id>):
// the inbox lists it in plain words, and its thread's card says what applying it would do, with Apply
// and Decline and no Claim. Nothing is clicked: applying is the principal's.
import { hydrated, until } from '../lib.mjs'

export async function run({ page, base, owner, step, must }) {
  const id = process.env.WORKBUS_PROPOSAL
  if (!id) return void (await step('a proposal to render (WORKBUS_PROPOSAL)', false))
  const task = (await owner.get('/messages/' + id + '?limit=1')).message
  await must('#' + id + ' is an open proposal', !!task.labels['board.doc.proposal'] && ['ready', 'waiting', 'claimed', 'blocked'].includes(task.task?.state), task.task?.state)
  const preview = await owner.get('/docs/proposals/' + id)
  await page.goto(base + '/')
  await hydrated(page)
  const item = page.locator('[data-testid=inbox] [data-item="' + id + '"]')
  const what = async () => (await item.getByTestId('inbox-what').innerText()).trim()
  await step('the inbox says what it is, in plain words', await until(async () => /^A change to the org: Changes \S+: /.test(await what()), 20_000), await what().catch(() => ''))
  await item.click()
  const card = page.getByTestId('proposal')
  await must('its card shows', await until(() => card.isVisible(), 15_000))
  let text = ''
  await step("the card says what applying does, from the board's read of it", await until(async () => /A CHANGE TO THE ORG/i.test((text = (await card.innerText()).replace(/\s+/g, ' '))) && text.includes('Changes ' + preview.path + ':'), 15_000), text)
  await step('with Apply and Decline, and no Claim', (await card.getByRole('button', { name: /Apply/ }).count()) === 1 && (await card.getByRole('button', { name: 'Decline' }).count()) === 1 && (await page.getByTestId('thread-pane').getByRole('button', { name: /^Claim$/ }).count()) === 0)
  await step(preview.stale ? 'stale: the card says applying it would be refused' : 'not stale: no warning', preview.stale ? (await card.getAttribute('data-stale')) === 'yes' : (await card.getAttribute('data-stale')) === null, { stale: preview.stale })
  await step('nothing was applied', (await owner.get('/messages/' + id + '?limit=1')).message.task.state === task.task.state)
}

// Signed in: the app answers as the board's owner through its own origin, and the frame draws from
// the bus as that person.
import { until } from '../lib.mjs'

export async function run({ page, base, owner, run: id, channel, must, step }) {
  await must("the bus answers through the app's origin as the board's owner", owner.me.kind === 'person' && (owner.me.can?.['*'] ?? []).includes('manage'), { actor: owner.actor, can: owner.me.can })
  await owner.post('/messages', { channel, text: 'Signed in for the checks, run ' + id })
  await page.goto(base + '/')
  await page.getByRole('navigation', { name: 'Workbus' }).waitFor({ timeout: 30_000 }).catch(() => {})
  await must('the frame draws: the sidebar and its places', await page.getByRole('navigation', { name: 'Workbus' }).isVisible())
  // The page reads the bus as the person: the sidebar's channels come from it.
  await step('the sidebar lists a channel read from the bus', await until(() => page.locator('[data-channel="' + channel + '"]').isVisible(), 15_000))
}

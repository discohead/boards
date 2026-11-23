// Signed in (shell's frame): the app answers as the board's owner through its own origin; the
// sidebar, the profile at its foot, the top bar's view title, and its live cursor, which moves when
// someone else writes.
import { hydrated, until } from '../lib.mjs'

export async function run({ page, base, owner, other, run: id, channel, must, step }) {
  await must("the bus answers through the app's origin as the board's owner", owner.me.kind === 'person' && (owner.me.can?.['*'] ?? []).includes('manage'), { actor: owner.actor, can: owner.me.can })
  await owner.post('/messages', { channel, text: 'Signed in for the checks, run ' + id })
  await page.goto(base + '/')
  await hydrated(page)
  const sidebar = page.getByTestId('sidebar')
  await sidebar.waitFor({ timeout: 30_000 }).catch(() => {})
  await must('the frame draws: the sidebar', await sidebar.isVisible())
  const profile = await page.getByTestId('profile').innerText().catch(() => '')
  await step("the profile at the sidebar's foot is the owner, as Principal", profile.includes('Principal') && profile.includes(owner.me.name ?? owner.handle), profile.replace(/\n+/g, ' | '))
  await step('the top bar names the view', (await page.getByTestId('view-title').innerText().catch(() => '')).trim() === 'Inbox')
  await step('the sidebar lists a channel read from the bus', await until(() => page.getByTestId('sidebar').locator('a[href="/c/' + channel + '"]').isVisible(), 15_000))

  // The live cursor: "Live log / #n", and n moves when someone else posts.
  const cursor = async () => Number(/#(\d+)/.exec(await page.getByTestId('live-cursor').innerText().catch(() => ''))?.[1] ?? NaN)
  const started = await until(async () => Number.isFinite(await cursor()), 15_000)
  const before = await cursor()
  await other.post('/messages', { channel, text: 'Someone else writes, run ' + id })
  const moved = started && (await until(async () => (await cursor()) > before, 10_000))
  await step("the top bar's live cursor moves when someone else writes", moved, { before, after: await cursor() })
}

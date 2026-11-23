// Docs (design/workbus.md §9.3, design/docs.md): the tree, a doc by section, a section edit (at
// once, then settled), a conflict that keeps the editor's text, a section comment, another actor's
// comment arriving live, and the history's diff. The doc is made fresh in checks/docs.
import { until } from '../lib.mjs'

const body = (run) => `# Check ${run}

The doc the checks use. See [[checks/docs/missing-${run}]].

## Steps

Build, then ship:

\`\`\`sh
pnpm build
\`\`\`

### Canary

Watch the error rate.

### Rollback

Roll back with wrangler rollback.
`

export async function run({ page, base, owner, other, run: id, must, step }) {
  const made = await owner.post('/docs', { channel: 'checks/docs', slug: 'check-' + id, body: body(id) })
  const doc = made.message.id
  const key = (tail) => 'check-' + id + '/steps' + (tail ? '/' + tail : '')

  // The docs list: the doc is there, under its folder's chip; it opens in the pane, on its Document face.
  await page.goto(base + '/docs')
  const row = page.locator('[data-testid=doc-list] li[data-id="' + doc + '"]')
  await must('the docs list shows a new doc, by its path and revision', await until(() => row.isVisible(), 15_000), await row.innerText().catch(() => ''))
  await page.getByRole('group', { name: 'Filter' }).getByRole('button', { name: 'checks/' }).click()
  await step("the folder chip keeps it", await row.isVisible())
  await row.locator('button').click()
  const pane = page.getByTestId('thread-pane')
  const view = pane.getByTestId('doc')
  await view.waitFor({ timeout: 20_000 }).catch(() => {})
  await must('it opens in the thread pane, on its Document face', (await view.isVisible()) && page.url().includes('thread=' + doc) && page.url().includes('face=doc'), page.url())
  const item = page.locator('[role=treeitem][aria-selected=true]')
  await step("the sidebar's tree marks it, under checks/docs", (await item.getAttribute('data-path').catch(() => null)) === 'checks/docs/check-' + id, await item.getAttribute('data-path').catch(() => null))

  const sections = await pane.locator('[data-section]').evaluateAll((els) => els.map((el) => el.getAttribute('data-section')))
  await step('its body shows by section, with the board\'s keys', [key(), key('canary'), key('rollback')].every((k) => sections.includes(k)), sections)
  await step('code is highlighted', (await view.locator('pre.tm-code .th-token').count()) > 0)
  await step('a [[path]] to no doc is marked missing', (await view.locator('.doc-link--missing').count()) === 1)

  // A section edit: at once (the revision hasn't moved), then settled (it has, and the board has the text).
  const revision = () => view.getAttribute('data-revision')
  const r0 = await revision()
  const canary = pane.locator('[data-section="' + key('canary') + '"]')
  await canary.hover()
  await canary.getByRole('button', { name: 'Edit Canary' }).click()
  const mine = 'Watch the error rate for fifteen minutes (' + id + ').'
  await canary.getByLabel('Section text').fill(mine)
  await canary.getByRole('button', { name: 'Save' }).click()
  await step('a section edit shows at once', (await canary.innerText()).includes(mine) && (await revision()) === r0, { revision: await revision() })
  const moved = await until(async () => (await revision()) !== r0)
  const read = await owner.get('/docs/' + doc + '?section=' + encodeURIComponent(key('canary')))
  await must('and settles: the board has it, at a newer revision', moved && read.section?.text.includes(mine), { r0, r1: await revision() })

  // A conflict: the editor is open on Rollback when someone changes Rollback first.
  const rollback = pane.locator('[data-section="' + key('rollback') + '"]')
  await rollback.hover()
  await rollback.getByRole('button', { name: 'Edit Rollback' }).click()
  const draft = 'Roll back, then post in #deploys (' + id + ', mine).'
  await rollback.getByLabel('Section text').fill(draft)
  await owner.post('/docs/' + doc + '/edit', { revision: await revision(), edits: [{ section: key('rollback'), text: 'Use the dashboard (' + id + ', theirs).' }] })
  await rollback.getByRole('button', { name: 'Save' }).click()
  const conflict = rollback.getByTestId('section-conflict')
  await conflict.waitFor({ timeout: 10_000 }).catch(() => {})
  await step('a conflicting edit is refused, and the view says so', await conflict.isVisible())
  await step('the editor keeps its text, with theirs beside it', (await rollback.getByLabel('Section text').inputValue()) === draft && (await rollback.getByTestId('section-theirs').innerText().catch(() => '')).includes('theirs'))
  await rollback.getByRole('button', { name: 'Save mine over it' }).click()
  const over = await until(async () => (await owner.get('/docs/' + doc + '?section=' + encodeURIComponent(key('rollback')))).section?.text.includes(draft))
  await step('saving mine over it lands', over)

  // A comment on a section: pending at once, then settled, on that section.
  await rollback.hover()
  await rollback.getByRole('button', { name: 'Comment on Rollback' }).click()
  const text = 'Should this be automated? (' + id + ')'
  await rollback.getByLabel('Comment on this section').fill(text)
  await rollback.getByRole('button', { name: 'Comment' }).last().click()
  await step('a section comment shows at once, pending', (await rollback.locator('[data-testid=comment][data-pending=yes]').count()) === 1)
  const settled = await until(async () => (await rollback.locator('[data-testid=comment][data-pending=yes]').count()) === 0)
  const replies = (await owner.get('/messages/' + doc + '?limit=500')).replies
  await step('and settles, on that section', settled && replies.some((m) => m.text === text && m.labels['board.doc.section'] === key('rollback')))

  // Someone else comments: it arrives live.
  const theirs = 'The canary needs a dashboard link. (' + id + ', from ' + other.handle + ')'
  await other.post('/messages', { re: doc, text: theirs, section: key('canary') })
  const live = await until(async () => (await canary.innerText()).includes(theirs))
  await step("another actor's comment arrives live", live)

  // History: an edit and its diff.
  await pane.getByRole('button', { name: 'History' }).click()
  await pane.locator('[data-testid=doc-history] li button:not([disabled])').first().click()
  const diff = await until(async () => (await pane.locator('[data-testid=doc-diff] pre div').count()) > 0)
  await step('history shows an edit and its diff', diff)
}

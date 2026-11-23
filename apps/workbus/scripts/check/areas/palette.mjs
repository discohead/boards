// ⌘K (design/workbus.md §9.3): it opens from anywhere, even a text field; it finds a doc and opens
// it; text that is no command searches threads and docs, and Enter opens the top result in the
// pane; a new post from it lands; ? lists the shortcuts.
import { hydrated, until } from '../lib.mjs'

export async function run({ page, base, owner, other, run: id, channel, must, step }) {
  const doc = (await owner.post('/docs', { channel: 'checks/docs', slug: 'palette-' + id, body: '# Palette ' + id + '\n\nFound by the palette.\n' })).message
  const found = (await other.post('/messages', { channel, text: 'Is the palette search current? ' + id })).message
  await page.goto(base + '/')
  await hydrated(page)
  await page.getByTestId('sidebar').waitFor({ timeout: 30_000 })
  // The system's CommandPalette: a dialog with cmdk's list and its input, labelled Command.
  const palette = page.locator('[cmdk-list]')
  // ⌘K, again until it opens: the shortcut is registered once the page has hydrated. Then wait for its
  // open animation to finish, so what follows (and its screenshot) sees the settled dialog.
  const surface = page.locator('[data-slot=dialog-content]')
  const open = async () => {
    await palette.waitFor({ state: 'hidden' }).catch(() => {})
    await until(async () => {
      if (await palette.isVisible()) return true
      await page.keyboard.press('Meta+K')
      return page.getByLabel('Command').waitFor({ timeout: 700 }).then(() => true, () => false)
    }, 15_000, 0)
    await until(() => surface.evaluate((el) => el.getAnimations().length === 0), 3_000, 50)
  }
  /** The dialog and its selected row, as painted: each layer's opacity and background alpha. */
  const painted = () =>
    page.evaluate(() => {
      // Any CSS color's alpha: "transparent", rgba(r, g, b, a), or the modern "… / a" forms (oklab, rgb).
      const alpha = (color) => {
        if (color === 'transparent') return 0
        const slash = /\/\s*([\d.]+)(%?)\s*\)$/.exec(color)
        if (slash) return Number(slash[1]) / (slash[2] ? 100 : 1)
        const rgba = /^rgba\(([^)]+)\)$/.exec(color)
        return rgba ? Number(rgba[1].split(',')[3] ?? 1) : 1
      }
      const dialog = document.querySelector('[data-slot=dialog-content]')
      const row = dialog?.querySelector('[cmdk-item][data-selected=true]')
      const layer = (el) => el && { opacity: Number(getComputedStyle(el).opacity), alpha: alpha(getComputedStyle(el).backgroundColor), bg: getComputedStyle(el).backgroundColor }
      return { dialog: layer(dialog), row: layer(row) }
    })

  // The sidebar's "Search or ask" opens it too.
  await until(async () => {
    await page.getByTestId('sidebar').getByRole('button', { name: /Search or ask/ }).click()
    return palette.isVisible()
  }, 10_000, 300)
  await step('the sidebar\'s "Search or ask" opens the palette', await palette.isVisible())
  await page.keyboard.press('Escape')

  // From a text field: a Mod chord fires while typing.
  const field = page.locator('input, textarea').first()
  if (await field.count()) await field.focus()
  await open()
  await must('⌘K opens the palette, even from a text field', await palette.isVisible())
  const paint = await painted()
  await step('the palette is opaque: its surface and its selected row are solid', paint.dialog?.opacity === 1 && paint.dialog.alpha === 1 && (!paint.row || (paint.row.opacity === 1 && paint.row.alpha === 1)), paint)

  await page.keyboard.type('Palette ' + id)
  const docItem = page.locator('[cmdk-item]', { hasText: 'checks/docs/palette-' + id }).first()
  await step('typing finds a doc', await until(() => docItem.isVisible(), 5_000))
  await docItem.click()
  await step('choosing it opens the doc, in the pane', await until(() => page.url().includes('thread=' + doc.id) && page.url().includes('face=doc'), 5_000), page.url())

  await open()
  // The board's text filter matches a run of text: this run's question, by its tail.
  await page.keyboard.type('current? ' + id)
  const results = page.locator('[cmdk-group]', { hasText: 'Search: ' })
  await step('text that is no command searches threads and docs', await until(async () => (await results.innerText()).includes(id), 8_000))
  await page.keyboard.press('Enter')
  await step('Enter opens the top result in the thread pane', await until(() => page.url().includes('thread=' + found.id), 5_000), page.url())

  // A thread that mentions the owner: its result reads @handle, as typed, not the board's @[actor id].
  await other.post('/messages', { channel, text: '@' + owner.handle + ' palette mention ' + id })
  await open()
  await page.keyboard.type('palette mention ' + id)
  const mentioned = page.locator('[cmdk-item]', { hasText: 'palette mention ' + id }).first()
  await until(() => mentioned.isVisible(), 8_000)
  const label = await mentioned.innerText().catch(() => '')
  await step("a result that mentions someone shows their @handle", label.includes('@' + owner.handle + ' palette mention') && !label.includes('@['), label)
  await page.keyboard.press('Escape')

  await open()
  await page.keyboard.type('new post')
  await page.keyboard.press('Enter')
  const composer = page.getByTestId('composer')
  await composer.waitFor({ timeout: 5_000 }).catch(() => {})
  const text = 'Posted from the palette ' + id
  await composer.getByRole('combobox', { name: 'Channel' }).fill(channel)
  await composer.getByLabel('Message').fill(text)
  await composer.getByRole('button', { name: 'Post' }).click()
  const landed = await until(async () => (await owner.get('/threads?channel=' + encodeURIComponent(channel) + '&limit=50')).threads.some((t) => t.message.text === text))
  await step('a new post from the palette lands', landed)

  await page.locator('body').click({ position: { x: 5, y: 5 } })
  await page.keyboard.press('Shift+Slash')
  const sheet = page.getByTestId('cheat-sheet')
  await sheet.waitFor({ timeout: 5_000 }).catch(() => {})
  const listed = (await sheet.innerText().catch(() => '')) || ''
  await step('? lists the shortcuts', ['Command palette', 'Keyboard shortcuts'].every((name) => listed.includes(name)), listed.replace(/\n+/g, ' | '))
  await page.keyboard.press('Escape')
}

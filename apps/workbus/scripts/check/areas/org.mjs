// The org views (design/workbus.md §4.3, §9.3): the sidebar's Org & seats opens /org; the org
// chart draws the delegates_to tree when the org-chart profile holds, and says why when it doesn't;
// every edge shows as the prototype draws it; the teams list opens a team's page (purpose, seats with
// live states, edges); the seat directory shows each seat's state as its Seat reports it. A seat's
// config is a form on its page: it reads the doc's json#seat@1 block, refuses what the schema
// refuses beside the field (sending nothing), shows the board's refusal (a stale revision), writes
// a good change as the principal with the charter untouched, and follows the reconciler: applied,
// or its reply when the change can't apply. No model is called. Local only: it edits org docs.
import { hydrated, until } from '../lib.mjs'

const FENCE = /(```json#(seat@[12]|team@1)[^\n]*\n)([\s\S]*?)(\n```)/

export async function run({ page, base, owner, step, must }) {
  const status = async (key) => (await page.context().request.get(base + '/api/seats/' + key)).json()
  const docAt = (path) => owner.get('/docs?path=' + path)
  /** Edits a doc's block over the board's API, as the owner: change gets the block's data and returns it changed. */
  const editBlock = async (path, change) => {
    const { doc, body } = await docAt(path)
    const found = FENCE.exec(body)
    const next = body.replace(FENCE, (_a, open, _k, json, close) => open + JSON.stringify(change(JSON.parse(json)), null, 2) + close)
    return (await owner.post('/docs/' + doc.id + '/edit', { revision: doc.revision, body: next })).doc.revision
  }

  // The org-chart profile is opt-in (org/structure's json#org@1). Start without it, as the seed does.
  const ORG_BLOCK = /\n*```json#org@1\n[\s\S]*?\n```\n?/
  const structure = await docAt('org/structure')
  const setStructure = async (body) => {
    const { doc } = await docAt('org/structure')
    if ((await docAt('org/structure')).body !== body) await owner.post('/docs/' + doc.id + '/edit', { revision: doc.revision, body })
  }
  const without = structure.body.replace(ORG_BLOCK, '\n')
  await setStructure(without)

  /** Sets a seat doc's block version, its data as it is. */
  const setVersion = async (path, version) => {
    const { doc, body } = await docAt(path)
    const next = body.replace(/json#seat@[12]/, 'json#seat@' + version)
    if (next !== body) await owner.post('/docs/' + doc.id + '/edit', { revision: doc.revision, body: next })
  }

  await page.goto(base + '/')
  await hydrated(page)
  await page.getByRole('navigation').getByRole('link', { name: 'Org & seats' }).click()
  const org = page.getByTestId('org')
  await must("the sidebar's Org & seats opens /org", await until(async () => page.url().endsWith('/org') && (await org.isVisible()), 15_000), page.url())

  // Not opted in, but the seeded delegations happen to form a chart: it's drawn, labeled as such.
  const noChart = page.getByTestId('no-chart')
  const chart = page.getByTestId('org-chart')
  const unlabeled = page.getByTestId('chart-not-opted-in')
  await step('without the opt-in, a graph that holds is drawn, labeled as not held to it', await until(async () => (await chart.isVisible()) && (await unlabeled.isVisible()) && (await unlabeled.innerText()).includes('json#org@1'), 15_000), await unlabeled.innerText().catch(() => ''))

  // Opted in (org/structure gets the block, appended; org-setup registers org@1): the chart, no label.
  await setStructure(without.trimEnd() + '\n\n```json#org@1\n{ "profile": "org-chart" }\n```\n')
  await must('opted in, the org chart shows, the profile holding, without the label', await until(async () => (await chart.isVisible()) && (await unlabeled.count()) === 0, 20_000))
  const order = await chart.locator('[data-chart-seat]').evaluateAll((cards) => cards.map((card) => card.getAttribute('data-chart-seat')))
  await step('advisor at its root, op under it, ada under op', order.join(' ') === 'advisor op ada', order)
  const opCard = chart.locator('[data-chart-seat=op]')
  await step('each card a seat: square avatar, name, @handle, state', (await opCard.innerText()).includes('Operator') && (await opCard.innerText()).includes('@op') && (await opCard.locator('[data-slot=avatar]').getAttribute('data-kind')) === 'agent' && (await opCard.locator('[data-slot=seat-state]').count()) === 1, (await opCard.innerText()).replace(/\n+/g, ' | '))

  // Edges: every team's, as the prototype draws them; the principal is You, @you.
  const edges = page.getByTestId('edges')
  const team = async (slug) => JSON.parse(FENCE.exec((await docAt('org/teams/' + slug)).body)[3])
  const all = [...(await team('core')).edges, ...(await team('eng')).edges]
  const shown = await edges.locator('[data-edge]').evaluateAll((rows) => rows.map((row) => row.getAttribute('data-edge')))
  await step('every edge in the team docs shows, once', all.length === shown.length && all.every((edge) => shown.includes(edge.from + ' ' + edge.kind + ' ' + edge.to)), { docs: all.length, shown })
  const edgeText = async (id) => (await edges.locator('[data-edge="' + id + '"]').innerText()).replace(/\s+/g, ' ')
  const drawn = [await edgeText('advisor delegates_to op'), await edgeText('op escalates_to principal'), await edgeText('ada escalates_to op')]
  await step('as @from — kind — @to, the principal as @you', /@advisor delegates to \S+ @op/.test(drawn[0]) && /@op escalates to YO @you/.test(drawn[1]) && /@ada escalates to \S+ @op/.test(drawn[2]), drawn)

  // Seats whose handles start alike get unlike initials, as the prototype draws them (AD, AV).
  const initials = async (key) => (await page.locator('[data-testid=seat-directory] [data-seat=' + key + '] [data-slot=avatar]').innerText()).trim()
  await step('Ada is AD and the advisor AV: unlike initials', (await initials('ada')) === 'AD' && (await initials('advisor')) === 'AV', [await initials('ada'), await initials('advisor')])

  // The same everywhere: the advisor's message in its DM is AV too.
  const fromAdvisor = (await owner.get('/messages?channel=dm/advisor')).messages.find((one) => one.by.actor === 'worker:workbus-app+advisor')
  if (fromAdvisor) {
    await page.goto(base + '/c/dm/advisor')
    const avatar = page.locator('[data-message="' + fromAdvisor.id + '"] [data-slot=avatar]').first()
    await step("the advisor's message in its DM is AV as well", await until(async () => (await avatar.innerText()).trim() === 'AV', 10_000), await avatar.innerText().catch(() => ''))
    await page.goto(base + '/org')
    await until(() => org.isVisible())
  } else await step("the advisor's message in its DM is AV as well", false, 'no message by the advisor in dm/advisor')

  // The directory: each seat's state is its Seat's.
  const row = (key) => page.locator('[data-testid=seat-directory] [data-seat=' + key + ']')
  for (const key of ['op', 'ada', 'advisor']) {
    const seat = await status(key)
    await step('the directory shows ' + key + ' ' + seat.state + ', as its Seat says', await until(async () => (await row(key).getAttribute('data-state')) === seat.state, 10_000), { shown: await row(key).getAttribute('data-state'), seat: seat.state })
  }

  // A team: Engineering's purpose, seats, and edges.
  await page.locator('[data-testid=teams-list] [data-team=eng]').click()
  const teamPage = page.getByTestId('team')
  await must('a team opens at /org/teams/eng', await until(async () => page.url().endsWith('/org/teams/eng') && (await teamPage.isVisible())))
  await step("its purpose: the team doc's prose", (await page.getByTestId('purpose').innerText()).includes('The team that builds and fixes things'))
  const teamSeats = await page.locator('[data-testid=team-seats] [data-seat]').evaluateAll((rows) => rows.map((row) => row.getAttribute('data-seat') + ':' + row.getAttribute('data-state')))
  await step('its seats, op and ada, with their states', teamSeats.length === 2 && teamSeats[0].startsWith('op:') && teamSeats[1].startsWith('ada:') && !teamSeats.some((one) => one.endsWith(':none')), teamSeats)
  await step('its edges, and its lead and queue', (await page.getByTestId('team-edges').locator('[data-edge]').count()) === 2 && (await teamPage.innerText()).includes('led by @op') && (await teamPage.innerText()).includes('eng/queue'))

  // The profile broken: advisor delegates to ada too, so ada has two delegators. The page says why.
  await editBlock('org/teams/core', (data) => ({ ...data, edges: [...data.edges, { from: 'advisor', kind: 'delegates_to', to: 'ada' }] }))
  await page.goto(base + '/org')
  await step('two delegators to one seat: no chart, and why', await until(async () => (await noChart.getAttribute('data-why')) === 'broken' && (await noChart.innerText()).includes('@ada has two seats delegating to it'), 20_000), await noChart.innerText().catch(() => ''))
  await editBlock('org/teams/core', (data) => ({ ...data, edges: data.edges.filter((edge) => !(edge.from === 'advisor' && edge.to === 'ada' && edge.kind === 'delegates_to')) }))
  await step('the profile whole again: the chart is back', await until(() => page.getByTestId('org-chart').isVisible(), 20_000))

  // Not opted in and the graph broken: no chart, why, and how to opt in.
  await setStructure(without)
  await editBlock('org/teams/core', (data) => ({ ...data, edges: [...data.edges, { from: 'advisor', kind: 'delegates_to', to: 'ada' }] }))
  await step("not opted in, a graph that doesn't hold: no chart, why, and how to opt in", await until(async () => (await noChart.getAttribute('data-why')) === 'not-opted-in' && (await noChart.innerText()).includes('two seats delegating') && (await noChart.innerText()).includes('json#org@1'), 20_000), await noChart.innerText().catch(() => ''))
  await editBlock('org/teams/core', (data) => ({ ...data, edges: data.edges.filter((edge) => !(edge.from === 'advisor' && edge.to === 'ada' && edge.kind === 'delegates_to')) }))

  // The seat form.
  await page.goto(base + '/seats/ada')
  await hydrated(page)
  await page.getByTestId('configure').click()
  const form = page.getByTestId('seat-form')
  await must("Configure opens ada's config form", await until(() => form.isVisible(), 10_000))
  const field = (name) => form.locator('[data-field="' + name + '"]')
  const before = await docAt('org/seats/ada')
  const block = JSON.parse(FENCE.exec(before.body)[3])
  await step('it reads her block: name, handle, model, sessions, budget, state', (await field('name').inputValue()) === block.name && (await field('handle').inputValue()) === block.handle && (await field('model').inputValue()) === block.occupant.model && (await field('sessions').inputValue()) === String(block.sessions) && (await field('budgetMonth').inputValue()) === String(block.budget.month) && (await field('state').inputValue()) === block.state)
  await step("a queue rule shows its channel", (await form.locator('[data-wake-row] [data-field^=wake-]').first().inputValue()) === 'eng/queue' && (await form.locator('[data-wake-row] [data-field^=wake-]').first().boundingBox()).width > 200)
  await step('her charter shows mentions as @handles, not actor IDs', !(await page.getByTestId('charter').innerText()).includes('@['))
  await step('and her tools, can, wakes, and approvals as rows', (await form.locator('[data-tool=computer]').isChecked()) && (await form.locator('[data-can-row]').count()) === Object.keys(block.can).length && (await form.locator('[data-wake-row]').count()) === block.wakes.length && (await form.locator('[data-approve-row]').count()) === Object.keys(block.approve ?? {}).length)

  // What the schema refuses is said beside the field, and nothing is sent.
  await field('sessions').fill('0')
  await field('budgetAlert').fill('2')
  await page.getByTestId('seat-save').click()
  const sessionsError = form.locator('[data-field=sessions] ~ [role=alert]')
  await step('sessions 0: "is at least 1", beside it', await until(async () => (await sessionsError.innerText()).includes('is at least 1')), await sessionsError.innerText().catch(() => ''))
  await step('alert 2: "is at most 1", beside it', (await form.locator('[data-field=budgetAlert] ~ [role=alert]').innerText().catch(() => '')).includes('is at most 1'))
  await step('and nothing was sent: the doc is at the same revision', (await docAt('org/seats/ada')).doc.revision === before.doc.revision)

  // The board's own refusal: the doc changed since the form read it.
  await field('budgetAlert').fill(String(block.budget.alert))
  await field('sessions').fill('3')
  await editBlock('org/seats/ada', (data) => ({ ...data, budget: { ...data.budget, alert: 0.75 } }))
  const touched = (await docAt('org/seats/ada')).doc.revision
  await page.getByTestId('seat-save').click()
  const refusal = page.getByTestId('seat-refusal')
  await step("a stale revision: the board's refusal, as it gave it", await until(() => refusal.isVisible(), 10_000) && /revision|conflict|changed/i.test(await refusal.innerText()), await refusal.innerText().catch(() => ''))
  await step('and the doc is as the other edit left it', (await docAt('org/seats/ada')).doc.revision === touched)

  // A good change, read fresh: written as the principal, charter untouched, applied by the reconciler.
  await page.getByRole('button', { name: 'Close config' }).click()
  await page.getByTestId('configure').click()
  await until(() => form.isVisible())
  const beforeSave = await docAt('org/seats/ada')
  const had = JSON.parse(FENCE.exec(beforeSave.body)[3])
  await field('sessions').fill('3')
  await page.getByTestId('seat-save').click()
  const saved = page.getByTestId('seat-saved')
  await must('a good change saves', await until(() => saved.isVisible(), 10_000), await page.getByTestId('seat-refusal').innerText().catch(() => ''))
  const after = await docAt('org/seats/ada')
  const written = JSON.parse(FENCE.exec(after.body)[3])
  await step("the doc's block has sessions 3, and nothing else of it changed", written.sessions === 3 && JSON.stringify({ ...written, sessions: had.sessions }) === JSON.stringify(had), written)
  await step('the charter is as it was', after.body.slice(after.body.indexOf('## Charter')) === beforeSave.body.slice(beforeSave.body.indexOf('## Charter')))
  const history = await owner.get('/docs/' + after.doc.id + '/history?after=' + beforeSave.doc.revision)
  const edit = (history.edits ?? history.history ?? history.revisions ?? []).find((one) => String(one.revision) === String(after.doc.revision))
  await step('written as the principal', edit?.by?.actor === owner.actor, edit ?? Object.keys(history))
  await step('and the edit touched only the section that holds the block', Array.isArray(edit?.sections) && edit.sections.every((one) => !/charter/.test(one.section)), edit?.sections)
  await step('the reconciler applies it: her Seat runs with 3 sessions, and the form says so', await until(async () => (await saved.getAttribute('data-state')) === 'applied' && (await status('ada')).runtime.sessions === 3, 30_000), { form: await saved.innerText(), seat: (await status('ada')).runtime?.sessions })

  // A change the schema takes but the reconciler can't apply: manage at org/, more than the app holds.
  await page.getByRole('button', { name: 'Close config' }).click()
  await page.getByTestId('configure').click()
  await until(() => form.isVisible())
  await form.getByRole('button', { name: 'Add a pattern' }).click()
  const rows = await form.locator('[data-can-row]').count()
  await field('can-' + (rows - 1)).fill('org/teams')
  await form.locator('[data-can-row="' + (rows - 1) + '"] [data-permission=edit]').check()
  await page.getByTestId('seat-save').click()
  await step("the reconciler's reply when it can't apply, and her Seat keeps what it had", await until(async () => (await saved.getAttribute('data-state')) === 'refused' && /can't apply/.test(await saved.innerText()), 30_000) && (await status('ada')).runtime.sessions === 3, await saved.innerText().catch(() => ''))

  // Versions: ada's doc stays seat@1 for a change seat@1 takes, and becomes seat@2 when it wakes for 'owned'.
  const versionOf = async (path) => /json#seat@(\d)/.exec((await docAt(path)).body)?.[1]
  await step("ada's doc stays json#seat@1 through a change seat@1 takes", (await versionOf('org/seats/ada')) === '1')
  await editBlock('org/seats/ada', () => block)
  await until(async () => (await status('ada')).runtime.sessions === block.sessions, 30_000)
  await page.getByRole('button', { name: 'Close config' }).click()
  await page.getByTestId('configure').click()
  await until(() => form.isVisible())
  await form.getByRole('button', { name: 'Add a rule' }).click()
  const wakeRows = await form.locator('[data-wake-row]').count()
  await form.locator('[data-wake-row="' + (wakeRows - 1) + '"] select').selectOption('owned')
  await page.getByTestId('seat-save').click()
  await step("adding the 'owned' wake writes it as json#seat@2, and it applies", await until(async () => (await versionOf('org/seats/ada')) === '2' && (await saved.getAttribute('data-state')) === 'applied', 30_000) && (await status('ada')).runtime.rules.owned === 'owned', { version: await versionOf('org/seats/ada'), form: await saved.innerText().catch(() => '') })

  // op's doc is json#seat@2: its form reads it, and a change keeps @2.
  await page.goto(base + '/seats/op')
  await hydrated(page)
  await page.getByTestId('configure').click()
  await must("op's form opens on its json#seat@2", await until(() => form.isVisible(), 10_000) && (await form.innerText()).includes('json#seat@2'))
  const opBefore = await docAt('org/seats/op')
  const opBlock = JSON.parse(FENCE.exec(opBefore.body)[3])
  await field('sessions').fill(String((opBlock.sessions ?? 1) + 1))
  await page.getByTestId('seat-save').click()
  await step("op's change is written at json#seat@2, applied", await until(async () => (await versionOf('org/seats/op')) === '2' && (await saved.getAttribute('data-state')) === 'applied', 30_000), await saved.innerText().catch(() => ''))
  await editBlock('org/seats/op', () => opBlock)

  // Back as it was.
  await editBlock('org/seats/ada', () => block)
  await setVersion('org/seats/ada', '1')
  await setStructure(structure.body)
  await until(async () => (await status('ada')).runtime.sessions === block.sessions, 30_000)
}

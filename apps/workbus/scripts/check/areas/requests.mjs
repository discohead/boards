// A request, end to end in the app (the UX pass after phase 3's verification run): the principal asks
// the advisor in its DM; the seats' work for it (a reply, the plan doc, the handoff, tasks, a hire
// and a team change proposed, a result doc, an approval held) carries org.request=<its ID>, as the
// seats stamp it. The DM shows "What happened with this"; /requests/<id> shows every step in time
// order with its state, the facts (tasks, proposals, docs, cost), and links; a stamped thread has the
// Request panel; the inbox says what each item is in plain words, with its request. Proposals have
// one pair of actions, Apply and Decline, never Claim; applying shows the result and links to it, and
// an Apply the board refuses leaves nothing held. No model is called: the seats write over the API
// as the app's profiles, paused so nothing they're woken for runs. Local only (WORKBUS_APP_TOKEN, a
// workload token for workbus-app, and the dev doors).
import { actor } from '../lib.mjs'
import { hydrated, until } from '../lib.mjs'

const FENCE = /(```json#(seat@[12]|team@1)[^\n]*\n)([\s\S]*?)(\n```)/
const bt3 = '\u0060\u0060\u0060'

export async function run({ page, base, board, owner, run: id, step, must }) {
  const appToken = process.env.WORKBUS_APP_TOKEN
  if (!appToken) return void (await step('a workload token for workbus-app (WORKBUS_APP_TOKEN)', false, 'set WORKBUS_APP_TOKEN to run this area'))
  const seat = (key) => actor(key, { api: base + '/b/' + board, headers: { authorization: 'Bearer ' + appToken, 'x-board-profile': key } })
  const [advisor, op, ada] = await Promise.all([seat('advisor'), seat('op'), seat('ada')])
  const dev = async (key, call, args = []) => (await fetch(base + '/dev/seat', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ seat: key, call, args }) })).json()
  // Paused in their docs (so a reconcile pass keeps them paused), the seats queue what wakes them
  // and run nothing; the queues are cleared, and the docs put back, at the end.
  const seatDocs = {}
  const setState = async (name, state) => {
    const { doc, body } = await owner.get('/docs?path=org/seats/' + name)
    const next = body.replace(/"state": "(active|paused)"/, '"state": "' + state + '"')
    if (next !== body) await owner.post('/docs/' + doc.id + '/edit', { revision: doc.revision, body: next })
  }
  for (const name of ['advisor', 'op', 'ada']) {
    seatDocs[name] = (await owner.get('/docs?path=org/seats/' + name)).body
    await setState(name, 'paused')
  }
  await must('the seats are paused, so nothing they are woken for runs', await until(async () => (await Promise.all(['advisor', 'op', 'ada'].map(async (name) => (await dev(name, 'status')).state))).every((state) => state === 'paused'), 30_000))
  const short = id.toLowerCase().replace(/[^a-z0-9]/g, '').slice(-6)
  const key = 'docs' + short
  try {
    // The request, and the work it caused, each stamped.
    const R = (await owner.post('/messages', { channel: 'dm/advisor', text: 'Help me plan a short doc of three npm date libraries and their weekly downloads ' + id })).message.id
    const stamp = { 'org.request': R }
    await advisor.post('/messages', { re: R, text: 'A plan: docs/plans/date-libs-' + short + '. Say "hand it off" when it looks right.', labels: stamp })
    const plan = (await advisor.post('/docs', { channel: 'docs/plans', slug: 'date-libs-' + short, body: '# npm date libraries\n\nThree libraries and their weekly downloads.\n', labels: stamp })).message.id
    const handoff = (await advisor.post('/tasks', { channel: 'ops/plans', text: 'Plan approved: docs/plans/date-libs-' + short + '. Make it happen.', for: 'worker:workbus-app+op', labels: stamp })).task.id
    const work = (await op.post('/tasks', { channel: 'eng/queue', text: 'Write the doc eng/date-libs-' + short + ' from the plan.', for: 'worker:workbus-app+ada', labels: stamp })).task.id
    const seatDoc = (name, handle) => '# ' + name + '\n\n' + bt3 + 'json#seat@1\n' + JSON.stringify({ role: 'engineer', name, handle, tools: ['board'], can: { 'eng/': ['read', 'post', 'react', 'label'] }, wakes: ['assigned'], budget: { month: 0.05, alert: 0.8 }, state: 'paused' }, null, 2) + '\n' + bt3 + '\n\n## Charter\n\nWrite short docs.\n'
    const propose = async (seatActor, body) => {
      const made = (await seatActor.post('/docs', { channel: 'org/seats', slug: key, body, propose: true, note: 'A docs engineer for the npm date-libs doc, on a test budget.' })).proposal.id
      await seatActor.post('/messages/' + made + '/labels', { set: stamp })
      return made
    }
    const hire = await propose(op, seatDoc('Dana', key))
    const twin = await propose(op, seatDoc('Dana Two', key + 'b'))
    const eng = await owner.get('/docs?path=org/teams/eng')
    const team = JSON.parse(FENCE.exec(eng.body)[3])
    const nextTeam = { ...team, seats: [...team.seats, key], edges: [...(team.edges ?? []), { from: 'op', kind: 'delegates_to', to: key }] }
    const teamEdit = (await op.post('/docs/' + eng.doc.id + '/edit', { revision: eng.doc.revision, body: eng.body.replace(FENCE, (_a, open, _k, _j, close) => open + JSON.stringify(nextTeam, null, 2) + close), propose: true, note: 'Adds the new docs engineer to Engineering, with an edge from op.' })).proposal.id
    await op.post('/messages/' + teamEdit + '/labels', { set: stamp })
    // The same change proposed twice, as op did live: once the first applies, the second is stale.
    const teamAgain = (await op.post('/docs/' + eng.doc.id + '/edit', { revision: eng.doc.revision, body: eng.body.replace(FENCE, (_a, open, _k, _j, close) => open + JSON.stringify(nextTeam, null, 2) + close), propose: true, note: 'The same again.' })).proposal.id
    await op.post('/messages/' + teamAgain + '/labels', { set: stamp })
    const extra = (await op.post('/docs', { channel: 'docs/plans', slug: 'extra-' + short, body: '# Extra\n\nNot needed.\n', propose: true })).proposal.id
    await op.post('/messages/' + extra + '/labels', { set: stamp })
    // Ada does the work, and holds a command for the principal.
    const claim = await ada.post('/tasks/' + work + '/claim', { lease: 60 })
    const result = (await ada.post('/docs', { channel: 'eng', slug: 'date-libs-' + short, body: '# npm date libraries\n\n| library | weekly |\n| --- | --- |\n| date-fns | 30M |\n', labels: stamp })).message.id
    await ada.post('/tasks/' + work + '/complete', { epoch: claim.claim.epoch, token: claim.claim.token, result: 'Wrote eng/date-libs-' + short })
    const approval = (await ada.post('/tasks', { channel: 'eng/queue', text: '@ada asks to run exec in #' + work + ':\n\n' + bt3 + 'json\n{\n "command": "export default () => \\"' + short + '\\""\n}\n' + bt3, labels: stamp })).task.id
    await ada.post('/tasks/' + approval + '/block', { reason: 'Approve or deny exec for @ada', kind: 'approval' })
    // What it cost: a run of Ada's in the work's thread, recorded by her Seat (no model).
    await dev('ada', 'wake', [{ cursor: 'check-' + short, type: 'task.created', message: { id: work, re: null } }, { board, wake: 'seat.ada', principal: 'worker:workbus-app', actor: 'worker:workbus-app+ada', rules: ['assigned'], match: 'assigned', attempt: 1 }])
    const now = new Date().toISOString()
    await dev('ada', 'ended', ['seat.ada:check-' + short, { operationId: 'seat.ada:check-' + short, status: 'done', usage: { model: 'anthropic/claude-haiku-5-5', steps: 2, tokens: { input: 10, output: 20, cacheRead: 0, cacheWrite: 0 }, cost: 0.0012, tools: [], logs: [], started: now, ended: now } }])

    // The DM: what happened with this.
    await page.goto(base + '/c/dm/advisor')
    await hydrated(page)
    const link = page.locator('[data-message="' + R + '"] [data-testid=request-link]')
    await must('the request in the DM has "What happened with this"', await until(async () => (await link.count()) === 1 && /What happened with this/.test(await link.innerText()), 20_000))
    await link.click()
    const request = page.getByTestId('request')
    await must('it opens /requests/' + R, await until(async () => page.url().endsWith('/requests/' + R) && (await request.isVisible())))
    const facts = page.getByTestId('request-facts')
    const factText = async () => (await facts.innerText()).replace(/\s+/g, ' ')
    await step('its facts: tasks 1 of 3 done, 1 open, 1 held; 5 proposals waiting; 2 docs; $0.0012 over 1 run by @ada', await until(async () => /tasks 1\/3 done, 1 open, 1 held/.test(await factText()) && /proposals 0 applied, 5 waiting on you/.test(await factText()) && /docs 2/.test(await factText()) && /over 1 run \(@ada\)/.test(await factText()) && Math.abs(Number(await facts.getAttribute('data-cost')) - 0.0012) < 1e-9, 15_000), await factText())
    const kinds = async () => page.locator('[data-testid=request-timeline] [data-entry]').evaluateAll((rows) => rows.map((row) => row.getAttribute('data-entry')))
    const order = ['asked', 'reply', 'doc', 'task', 'task', 'proposal', 'proposal', 'proposal', 'proposal', 'proposal', 'claimed', 'doc', 'completed', 'task', 'held']
    await step('every step in time order: asked, the reply, the plan, the handoff, the work, the proposals, taken, the result doc, completed, the approval held', await until(async () => JSON.stringify(await kinds()) === JSON.stringify(order), 10_000), await kinds())
    const timeline = (await page.getByTestId('request-timeline').innerText()).replace(/\s+/g, ' ')
    await step('in plain words, with who: "@advisor wrote docs/plans/…", "@op made a task in eng/queue for @ada", "@op proposed: Creates the seat Dana"', timeline.includes('@advisor wrote docs/plans/date-libs-' + short) && timeline.includes('@op made a task in eng/queue for @ada') && timeline.includes('@op proposed: Creates the seat Dana (@' + key + '), engineer, $0.05 a month') && timeline.includes('@ada completed #' + work), timeline.slice(0, 600))
    const workRow = page.locator('[data-testid=request-timeline] [data-entry=task]').nth(1)
    await step("each task with its state now: the work's is done", (await workRow.locator('[data-state]').first().getAttribute('data-state')) === 'done', await workRow.innerText())
    await workRow.locator('button').first().click()
    await step('a step opens its thread', await until(async () => page.url().includes('thread=' + work) && (await page.getByTestId('thread-pane').isVisible())), page.url())

    // A stamped thread's Request panel.
    await page.goto(base + '/tasks?thread=' + work)
    await hydrated(page)
    const panel = page.getByTestId('request-panel')
    await step('a stamped thread shows the Request panel, with its facts and a link to the request', await until(async () => (await panel.getAttribute('data-request')) === R && /tasks 1\/3 done/.test((await panel.innerText()).replace(/\s+/g, ' ')), 15_000) && (await panel.locator('[data-testid=request-link]').getAttribute('href')) === '/requests/' + R)

    // The inbox, in plain words, each with its request.
    await page.goto(base + '/')
    await hydrated(page)
    const item = (thread) => page.locator('[data-testid=inbox] [data-item="' + thread + '"]')
    const what = async (thread) => (await item(thread).getByTestId('inbox-what').innerText()).trim()
    await step('a hire: "A hire to apply: Dana (@…), engineer, $0.05 a month"', await until(async () => (await what(hire)) === 'A hire to apply: Dana (@' + key + '), engineer, $0.05 a month', 15_000), await what(hire).catch(() => ''))
    await step('an approval: "An approval for a command: Ada wants to run exec"', await until(async () => (await what(approval)) === 'An approval for a command: Ada wants to run exec', 10_000), await what(approval).catch(() => ''))
    const teamWhat = await what(teamEdit).catch(() => '')
    await step('a team change: "A change to the org: Changes org/teams/eng: adds the seat @…"', teamWhat.startsWith('A change to the org: Changes org/teams/eng: adds the seat @' + key), teamWhat)
    await step('each with who asked and its request', (await item(hire).innerText()).includes('@op') && (await item(hire).locator('[data-testid=request-link]').getAttribute('href')) === '/requests/' + R)

    // A proposal: one pair of actions, Apply and Decline; never Claim.
    await item(hire).click()
    const card = page.getByTestId('proposal')
    await must('the hire opens with its card', await until(() => card.isVisible(), 10_000))
    const cardText = (await card.innerText()).replace(/\s+/g, ' ')
    await step('"A hire to apply", "Creates the seat Dana (@…), engineer, $0.05 a month.", Apply ⌘↵ and Decline', /A HIRE TO APPLY/i.test(cardText) && cardText.includes('Creates the seat Dana (@' + key + '), engineer, $0.05 a month.') && (await card.getByRole('button', { name: /Apply/ }).count()) === 1 && (await card.getByRole('button', { name: 'Decline' }).count()) === 1, cardText)
    await page.getByRole('tab', { name: /Task/ }).click().catch(() => {})
    await step('no Claim anywhere on it: not the card, not the Task face', (await page.getByTestId('thread-pane').getByRole('button', { name: /^Claim$/ }).count()) === 0 && (await page.getByTestId('thread-pane').getByRole('button', { name: /^Complete$/ }).count()) === 0)
    await card.getByRole('button', { name: /Apply/ }).click()
    const applied = page.getByTestId('proposal-applied')
    await step('Apply: applied, saying what it made, with a link to it', await until(async () => (await applied.isVisible()) && (await applied.locator('[data-testid=proposal-result-link]').getAttribute('href')) === '/seats/' + key, 15_000), await applied.innerText().catch(() => ''))
    await step('the board made the seat doc org/seats/' + key + ', and the task is completed with no claim', (await owner.get('/docs?path=org/seats/' + key)).doc?.path === 'org/seats/' + key && (await owner.get('/messages/' + hire + '?limit=1')).message.task.state === 'completed')

    // An Apply the board refuses (the same key, now taken) leaves nothing held.
    await page.goto(base + '/?thread=' + twin)
    await hydrated(page)
    await until(() => card.isVisible(), 10_000)
    await card.getByRole('button', { name: /Apply/ }).click()
    await page.waitForTimeout(2_500)
    const twinTask = (await owner.get('/messages/' + twin + '?limit=1')).message.task
    await step('an Apply the board refuses leaves it ready, with no claim held', twinTask.state === 'ready' && twinTask.claim === null, twinTask)

    // The team change, applied: its edge lands.
    await page.goto(base + '/?thread=' + teamEdit)
    await hydrated(page)
    await until(() => card.isVisible(), 10_000)
    await step('the team change says what it changes', /adds the seat @/.test(await card.innerText()) && /op → .* delegates_to/.test(await card.innerText()), (await card.innerText()).replace(/\s+/g, ' '))
    await card.getByRole('button', { name: /Apply/ }).click()
    await step('applied: org/teams/eng has the seat and the edge', await until(async () => {
      const after = JSON.parse(FENCE.exec((await owner.get('/docs?path=org/teams/eng')).body)[3])
      return after.seats.includes(key) && after.edges.some((edge) => edge.from === 'op' && edge.to === key && edge.kind === 'delegates_to')
    }, 10_000))

    // The same change, proposed again before the first applied: stale now, and the card says so.
    await page.goto(base + '/?thread=' + teamAgain)
    await hydrated(page)
    await until(() => card.isVisible(), 10_000)
    await step('a whole-body change proposed before another landed: the card says applying it will be refused', await until(async () => (await card.getAttribute('data-stale')) === 'yes' && /applying it will be refused/.test(await page.getByTestId('proposal-stale').innerText()), 10_000))

    // Decline, with a reason.
    await page.goto(base + '/?thread=' + extra)
    await hydrated(page)
    await until(() => card.isVisible(), 10_000)
    await card.getByRole('button', { name: 'Decline' }).click()
    await page.getByTestId('decline-form').getByRole('textbox').fill('Not needed for this request')
    await page.getByTestId('decline-form').getByRole('button', { name: 'Decline' }).click()
    await step('Decline cancels it, with the reason given', await until(async () => {
      const task = (await owner.get('/messages/' + extra + '?limit=1')).message.task
      return task.state === 'canceled' && task.reason === 'Not needed for this request'
    }, 10_000))

    // The request again: the applied proposals show.
    await page.goto(base + '/requests/' + R)
    await step('the request now: 2 proposals applied, 2 waiting', await until(async () => /proposals 2 applied, 2 waiting on you/.test(await factText()), 15_000), await factText().catch(() => ''))

    // Tidy: what's still open, closed; the hire's seat and the team edit taken back.
    for (const task of [handoff, twin, teamAgain, approval]) await owner.post('/tasks/' + task + '/cancel', { reason: 'check done' }).catch(() => {})
    void plan
    void result
    // The hire's seat doc goes too, so the org is as it was (its Seat retires; its history stays).
    const hired = await owner.get('/docs?path=org/seats/' + key).catch(() => null)
    if (hired?.doc) await owner.post('/messages/' + hired.doc.id + '/delete', {}).catch(() => {})
    const teamNow = await owner.get('/docs?path=org/teams/eng')
    await owner.post('/docs/' + teamNow.doc.id + '/edit', { revision: teamNow.doc.revision, body: teamNow.body.replace(FENCE, (_a, open, _k, _j, close) => open + JSON.stringify(team, null, 2) + close) }).catch(() => {})
  } finally {
    // The seats' queues cleared (nothing runs), and each as it was.
    for (const name of ['advisor', 'op', 'ada', key]) {
      const status = await dev(name, 'status').catch(() => null)
      for (const wake of status?.wakes ?? []) if (wake.state === 'queued') await dev(name, 'ended', [wake.id, null, 'cleared by the requests check'])
    }
    for (const name of ['advisor', 'op', 'ada']) await setState(name, 'active')
  }
}

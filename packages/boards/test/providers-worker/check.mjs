// Checks the Slack and Linear providers end to end, as the board's own syncs (the webhooks at the
// board's /webhooks/<key>, kept by each sync's Inbox; replies copied back by its courier), against
// the test Worker under wrangler dev:
// each platform's requests signed exactly as the platform signs them, each delivery sent twice, a
// local mock of Slack's Web API and Linear's GraphQL API that records what the board sends, and the
// board read back to show what landed, once each.
// Setup, from packages/boards (the values are test values; the check is told the same ones):
//   cd test/providers-worker
//   wrangler secrets-store secret create 0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f --name slack-signing-secret --value <s> --scopes workers --persist-to <dir>
//   wrangler secrets-store secret create 0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f --name slack-bot-token --value <t> --scopes workers --persist-to <dir>
//   wrangler dev --port 8813 --ip 127.0.0.1 --persist-to <dir> --env-file <file with BOARD_ISSUER_KEY, LINEAR_WEBHOOK_SECRET, LINEAR_API_KEY>
//   SLACK_SIGNING_SECRET=<s> SLACK_BOT_TOKEN=<t> LINEAR_WEBHOOK_SECRET=… LINEAR_API_KEY=… node test/providers-worker/check.mjs
// RACE=0 skips sending Slack's echo before chat.postMessage answers.
import { createHmac } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { createServer } from 'node:http'
import { fileURLToPath } from 'node:url'

const ORIGIN = process.env.ORIGIN ?? 'http://127.0.0.1:8813'
const SLACK_SECRET = process.env.SLACK_SIGNING_SECRET
const LINEAR_SECRET = process.env.LINEAR_WEBHOOK_SECRET
if (!SLACK_SECRET || !LINEAR_SECRET) throw new Error('set SLACK_SIGNING_SECRET and LINEAR_WEBHOOK_SECRET to what the Worker has')
const BOARD = process.env.BOARD_NAME ?? 'providers-' + Date.now().toString(36)
const URL_ = ORIGIN + '/b/' + BOARD
const pkg = fileURLToPath(new URL('../..', import.meta.url))
const TOKEN = execFileSync('node', ['scripts/issuer.mjs', 'token', 'jared', URL_], { cwd: pkg, encoding: 'utf8' }).trim()

const log = (...parts) => console.log(...parts)
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
let failures = 0
const check = (ok, what) => {
  if (!ok) failures++
  log((ok ? 'ok    ' : 'FAIL  ') + what)
}

// -- the platforms' APIs, mocked -----------------------------------------------------------------

const recorded = []
let nextTs = 1_700_000_900
let nextComment = 1
let onPost = null
const SLACK_USERS = { U0ADA: { name: 'ada', real_name: 'Ada Lovelace', profile: { display_name: 'Ada', image_72: 'https://avatars.test/ada.png' } }, U0BO: { name: 'bo', real_name: 'Bo Diddley', profile: { display_name: 'Bo' } } }
const SLACK_THREADS = {}
const mock = createServer(async (req, res) => {
  let body = ''
  for await (const chunk of req) body += chunk
  const url = new URL(req.url, 'http://mock')
  const entry = { method: req.method, path: url.pathname, query: Object.fromEntries(url.searchParams), authorization: req.headers.authorization, body: body ? JSON.parse(body) : null }
  recorded.push(entry)
  const send = (value) => (res.writeHead(200, { 'content-type': 'application/json' }), res.end(JSON.stringify(value)))
  if (url.pathname === '/slack/api/users.info') {
    const user = SLACK_USERS[url.searchParams.get('user')]
    return send(user ? { ok: true, user: { id: url.searchParams.get('user'), ...user } } : { ok: false, error: 'user_not_found' })
  }
  if (url.pathname === '/slack/api/conversations.replies') {
    const ts = url.searchParams.get('ts')
    return send({ ok: true, messages: [{ ts, thread_ts: SLACK_THREADS[ts] ?? ts }] })
  }
  if (url.pathname === '/slack/api/chat.postMessage') {
    const ts = String(nextTs++) + '.000100'
    entry.answered = ts
    // Slack's echo of the bot's message can beat chat.postMessage's answer: it's sent before the answer here.
    if (onPost) await onPost(entry.body, ts)
    return send({ ok: true, channel: entry.body.channel, ts, message: { text: entry.body.text, ts } })
  }
  if (url.pathname === '/linear/graphql') {
    const id = 'lc-' + nextComment++
    entry.answered = id
    return send({ data: { commentCreate: { success: true, comment: { id } } } })
  }
  res.writeHead(404).end()
})
await new Promise((resolve) => mock.listen(8814, '127.0.0.1', resolve))

// -- the board -----------------------------------------------------------------------------------

async function board(method, path, body) {
  const response = await fetch(URL_ + path, { method, headers: { authorization: 'Bearer ' + TOKEN, 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) })
  const text = await response.text()
  if (!response.ok) throw new Error(method + ' ' + path + ' answered ' + response.status + ': ' + text)
  return JSON.parse(text)
}
const thread = (id) => board('GET', '/messages/' + encodeURIComponent(id))
async function waitFor(what, fn, ms = 30_000) {
  const until = Date.now() + ms
  for (;;) {
    const value = await fn().catch(() => null)
    if (value) return value
    if (Date.now() > until) throw new Error('timed out waiting for ' + what)
    await sleep(250)
  }
}
async function counts(channel) {
  const { events } = await board('GET', '/events?channel=' + encodeURIComponent(channel) + '&last=100')
  const out = {}
  for (const event of events) out[event.type] = (out[event.type] ?? 0) + 1
  return out
}
const show = (message) => ({ id: message.id, by: message.author?.name + ' (' + message.by.actor + ')', text: message.deleted ? '(deleted)' : message.text, ...(message.editedAt ? { edited: true } : {}), ...(Object.keys(message.labels ?? {}).length ? { labels: message.labels } : {}), ...(Object.keys(message.reactions ?? {}).length ? { reactions: message.reactions } : {}), ...(message.origin ? { origin: message.origin.thread + ' / ' + message.origin.message } : {}) })

// -- Slack ---------------------------------------------------------------------------------------

function signSlack(body, at = Date.now()) {
  const stamp = String(Math.floor(at / 1000))
  return { 'x-slack-request-timestamp': stamp, 'x-slack-signature': 'v0=' + createHmac('sha256', SLACK_SECRET).update('v0:' + stamp + ':' + body).digest('hex') }
}
async function slack(payload, { times = 2, headers } = {}) {
  const body = JSON.stringify(payload)
  const answers = []
  for (let n = 0; n < times; n++) {
    // A retry is the same delivery, as Slack sends it: same event_id, signed again when it's sent.
    const response = await fetch(URL_ + '/webhooks/slack', { method: 'POST', headers: { 'content-type': 'application/json', ...(n > 0 ? { 'x-slack-retry-num': String(n), 'x-slack-retry-reason': 'http_timeout' } : {}), ...(headers ?? signSlack(body)) }, body })
    answers.push(response.status + ' ' + (await response.text()).trim())
  }
  return answers
}
const envelope = (id, event) => ({ token: 'legacy', team_id: 'T0TEAM', api_app_id: 'A0APP', type: 'event_callback', event_id: id, event_time: Math.floor(Date.now() / 1000), event })
const C = 'C0SYNCED'
const ROOT = '1700000000.000100', R1 = '1700000001.000200', R2 = '1700000002.000300'
SLACK_THREADS[R1] = ROOT
SLACK_THREADS[R2] = ROOT

log('board  ' + URL_)
log('\n# slack: verification')
{
  const body = JSON.stringify({ token: 'legacy', challenge: 'c-3x4mpl3', type: 'url_verification' })
  const answer = await fetch(URL_ + '/webhooks/slack', { method: 'POST', headers: { 'content-type': 'application/json', ...signSlack(body) }, body })
  const text = await answer.text()
  log('url_verification  ' + answer.status + ' ' + text)
  check(answer.status === 200 && text === 'c-3x4mpl3', 'url_verification answers its challenge')
  const event = envelope('Ev0BAD', { type: 'message', channel: C, user: 'U0ADA', text: 'forged', ts: '1700000000.999999' })
  const forged = await slack(event, { times: 1, headers: { ...signSlack(JSON.stringify(event)), 'x-slack-signature': 'v0=' + '0'.repeat(64) } })
  const stale = await slack(event, { times: 1, headers: signSlack(JSON.stringify(event), Date.now() - 6 * 60 * 1000) })
  log('bad signature     ' + forged[0])
  log('6 minutes old     ' + stale[0])
  check(forged[0].startsWith('401') && stale[0].startsWith('401'), 'a forged or stale request is 401')
}

log('\n# slack: deliveries, each sent twice')
const sent = {
  root: await slack(envelope('Ev01', { type: 'message', channel: C, user: 'U0ADA', text: 'Deploys to *staging* fail since <https://ci.test/run/7|run 7> &amp; I cannot see why', ts: ROOT, event_ts: ROOT, channel_type: 'channel' })),
  reply: await slack(envelope('Ev02', { type: 'message', channel: C, user: 'U0BO', text: '<@U0ADA> looks like the token expired', ts: R1, thread_ts: ROOT, channel_type: 'channel' })),
  reply2: await slack(envelope('Ev03', { type: 'message', channel: C, user: 'U0ADA', text: 'nvm, wrong thread', ts: R2, thread_ts: ROOT, channel_type: 'channel' })),
  edit: await slack(envelope('Ev04', { type: 'message', subtype: 'message_changed', hidden: true, channel: C, ts: '1700000003.000000', message: { type: 'message', user: 'U0BO', text: '<@U0ADA> looks like the deploy token expired yesterday', ts: R1, thread_ts: ROOT, edited: { user: 'U0BO', ts: '1700000003.000000' } }, previous_message: { type: 'message', user: 'U0BO', text: '<@U0ADA> looks like the token expired', ts: R1, thread_ts: ROOT } })),
  replyCount: await slack(envelope('Ev05', { type: 'message', subtype: 'message_changed', hidden: true, channel: C, ts: '1700000003.100000', message: { type: 'message', user: 'U0ADA', text: 'Deploys to *staging* fail since <https://ci.test/run/7|run 7> &amp; I cannot see why', ts: ROOT, thread_ts: ROOT, reply_count: 2 }, previous_message: { type: 'message', user: 'U0ADA', text: 'Deploys to *staging* fail since <https://ci.test/run/7|run 7> &amp; I cannot see why', ts: ROOT, thread_ts: ROOT, reply_count: 1 } })),
  react: await slack(envelope('Ev06', { type: 'reaction_added', user: 'U0ADA', reaction: 'thumbsup::skin-tone-2', item: { type: 'message', channel: C, ts: R1 }, item_user: 'U0BO', event_ts: '1700000004.000000' })),
  reactRoot: await slack(envelope('Ev07', { type: 'reaction_added', user: 'U0BO', reaction: 'eyes', item: { type: 'message', channel: C, ts: ROOT }, item_user: 'U0ADA', event_ts: '1700000005.000000' })),
  unreactRoot: await slack(envelope('Ev08', { type: 'reaction_removed', user: 'U0BO', reaction: 'eyes', item: { type: 'message', channel: C, ts: ROOT }, item_user: 'U0ADA', event_ts: '1700000006.000000' })),
  delete: await slack(envelope('Ev09', { type: 'message', subtype: 'message_deleted', hidden: true, channel: C, ts: '1700000007.000000', deleted_ts: R2, previous_message: { type: 'message', user: 'U0ADA', text: 'nvm, wrong thread', ts: R2, thread_ts: ROOT } })),
  unmapped: await slack(envelope('Ev10', { type: 'message', channel: 'C0ELSEWHERE', user: 'U0ADA', text: 'not synced', ts: '1700000008.000100' })),
  join: await slack(envelope('Ev11', { type: 'message', subtype: 'channel_join', channel: C, user: 'U0BO', text: '<@U0BO> has joined the channel', ts: '1700000009.000100' })),
}
for (const [what, answers] of Object.entries(sent)) log(what.padEnd(12) + answers.join('  |  '))

const slackRoot = await waitFor('the Slack root', async () => (await board('GET', '/sync/find?thread=' + encodeURIComponent('slack:' + C + ':' + ROOT))).thread)
const slackRootId = (await board('GET', '/sync/threads/' + encodeURIComponent(slackRoot))).root
const slackView = await waitFor('the Slack thread to settle', async () => {
  const view = await thread(slackRootId)
  const [r1, r2] = view.replies
  return view.replies.length === 2 && r1.editedAt && r1.reactions?.thumbs_up && r2.deleted && !view.message.reactions?.eyes ? view : null
})
log('\n# slack: the thread on the board')
log(JSON.stringify(show(slackView.message), null, 1))
for (const reply of slackView.replies) log(JSON.stringify(show(reply), null, 1))
const slackCounts = await counts('slack/general')
log('events in slack/general  ' + JSON.stringify(slackCounts))
check(slackCounts['message.posted'] === 3 && slackCounts['message.edited'] === 1 && slackCounts['reaction.added'] === 2 && slackCounts['reaction.removed'] === 1 && slackCounts['message.deleted'] === 1, 'each Slack delivery landed once: 3 posts, 1 edit, 2 reactions added, 1 removed, 1 delete')

log('\n# slack: a reply written on the board goes back, and its echo lands as nothing')
// The echo is sent while chat.postMessage hasn't answered yet: before the receipt exists.
if (process.env.RACE !== '0') onPost = async (sentBody, ts) => {
  const echo = envelope('Ev20', { type: 'message', channel: sentBody.channel, user: 'U0BOT', bot_id: 'B0BOT', app_id: 'A0APP', text: sentBody.text, ts, thread_ts: sentBody.thread_ts, channel_type: 'channel' })
  log('echo before answer  ' + (await slack(echo)).join('  |  '))
  await sleep(1500)
}
const before = recorded.length
const boardReply = await board('POST', '/messages', { re: slackRootId, text: 'Rotated the deploy token: <staging> & prod should go green now' })
log('board reply  #' + boardReply.message.id)
const slackSynced = await waitFor('the Slack receipt', async () => {
  const { targets } = await board('GET', '/messages/' + boardReply.message.id + '/sync')
  return targets.find((target) => target.message) ? targets : null
})
onPost = null
log('receipt  ' + JSON.stringify(slackSynced))
const posts = recorded.slice(before).filter((entry) => entry.path.endsWith('chat.postMessage'))
for (const entry of posts) log('slack got  POST ' + entry.path + '  auth=' + entry.authorization + '  ' + JSON.stringify(entry.body) + '  -> ts ' + entry.answered)
check(posts.length === 1 && posts[0].body.thread_ts === ROOT && posts[0].body.channel === C && posts[0].authorization === 'Bearer ' + process.env.SLACK_BOT_TOKEN, 'one chat.postMessage, in the root' + "'" + 's thread, with the bot token from Secrets Store')
check(slackSynced[0].message === posts[0]?.answered, 'the receipt records the ts Slack answered')
// Slack's later retry of the echo, after the receipt.
const lateEcho = envelope('Ev20', { type: 'message', channel: C, user: 'U0BOT', bot_id: 'B0BOT', text: posts[0].body.text, ts: posts[0].answered, thread_ts: ROOT })
log('echo again  ' + (await slack(lateEcho, { times: 1, headers: { ...signSlack(JSON.stringify(lateEcho)), 'x-slack-retry-num': '3' } })).join(''))
// The own echo waits for its receipt (1 s, then 2 s, ...) before it lands as nothing.
await waitFor('the echo to drain', async () => {
  const { events } = await board('GET', '/inbox/slack?limit=50')
  return events.length ? events : null
})
await sleep(9000)
const afterEcho = await thread(slackRootId)
const slackAfter = await counts('slack/general')
log('replies now  ' + afterEcho.replies.map((reply) => '#' + reply.id + ' ' + reply.author.name + (reply.deleted ? ' (deleted)' : '')).join(', '))
log('events in slack/general  ' + JSON.stringify(slackAfter))
check(afterEcho.replies.length === 3 && slackAfter['message.posted'] === 4, 'the echo, sent before and after the receipt, imported nothing')

// -- Linear --------------------------------------------------------------------------------------

async function linear(payload, { times = 2, sentAt, secret = LINEAR_SECRET } = {}) {
  const body = JSON.stringify({ ...payload, webhookTimestamp: sentAt ?? Date.now() })
  const signature = createHmac('sha256', secret).update(body).digest('hex')
  const answers = []
  for (let n = 0; n < times; n++) {
    const response = await fetch(URL_ + '/webhooks/linear', { method: 'POST', headers: { 'content-type': 'application/json; charset=utf-8', 'linear-signature': signature, 'linear-delivery': crypto.randomUUID(), 'linear-event': payload.type, 'user-agent': 'Linear-Webhook' }, body })
    answers.push(response.status + ' ' + (await response.text()).trim())
  }
  return answers
}
const ADA = { id: 'lin-user-ada', name: 'Ada Lovelace', email: 'ada@acme.test', avatarUrl: 'https://avatars.test/lada.png', type: 'user' }
const BO = { id: 'lin-user-bo', name: 'Bo Diddley', email: 'bo@acme.test', type: 'user' }
const TEAM = { id: 'team-eng', key: 'ENG', name: 'Engineering' }
const ISSUE = 'issue-0b1d'
const issue = (patch) => ({ id: ISSUE, identifier: 'ENG-42', number: 42, title: 'Checkout times out', description: 'Requests to /checkout hang for 30s.', url: 'https://linear.test/acme/issue/ENG-42', teamId: TEAM.id, team: TEAM, state: { id: 'st-todo', name: 'Todo', type: 'unstarted' }, labels: [{ id: 'lb-bug', name: 'Bug' }], labelIds: ['lb-bug'], creatorId: ADA.id, createdAt: '2026-11-20T08:00:00.000Z', updatedAt: '2026-11-20T08:00:00.000Z', ...patch })
const comment = (id, body, user, patch) => ({ id, body, issueId: ISSUE, issue: { id: ISSUE, identifier: 'ENG-42', title: 'Checkout times out', teamId: TEAM.id, team: TEAM }, userId: user.id, user, createdAt: '2026-11-20T08:05:00.000Z', updatedAt: '2026-11-20T08:05:00.000Z', ...patch })
const linearEnvelope = (type, action, data, extra = {}) => ({ action, actor: ADA, createdAt: new Date().toISOString(), data, url: 'https://linear.test/acme/issue/ENG-42', type, organizationId: 'org-acme', webhookId: 'wh-1', ...extra })

log('\n# linear: verification')
{
  const forged = await linear(linearEnvelope('Issue', 'create', issue()), { times: 1, secret: 'not-the-secret' })
  const stale = await linear(linearEnvelope('Issue', 'create', issue()), { times: 1, sentAt: Date.now() - 61_000 })
  log('bad signature     ' + forged[0])
  log('61 seconds old    ' + stale[0])
  check(forged[0].startsWith('401') && stale[0].startsWith('401'), 'a forged or stale delivery is 401')
}

log('\n# linear: deliveries, each sent twice')
const lsent = {
  issue: await linear(linearEnvelope('Issue', 'create', issue())),
  comment: await linear(linearEnvelope('Comment', 'create', comment('cm-1', 'Seeing it too, only in eu-west.', BO), { actor: BO })),
  commentEdit: await linear(linearEnvelope('Comment', 'update', comment('cm-1', 'Seeing it too, only in eu-west since 07:40.', BO, { updatedAt: '2026-11-20T08:06:00.000Z', editedAt: '2026-11-20T08:06:00.000Z' }), { actor: BO, updatedFrom: { body: 'Seeing it too, only in eu-west.', updatedAt: '2026-11-20T08:05:00.000Z' } })),
  state: await linear(linearEnvelope('Issue', 'update', issue({ state: { id: 'st-prog', name: 'In Progress', type: 'started' }, labels: [{ id: 'lb-fe', name: 'Frontend' }], labelIds: ['lb-fe'], updatedAt: '2026-11-20T08:07:00.000Z' }), { updatedFrom: { stateId: 'st-todo', labelIds: ['lb-bug'], updatedAt: '2026-11-20T08:00:00.000Z' } })),
  title: await linear(linearEnvelope('Issue', 'update', issue({ title: 'Checkout times out in eu-west', state: { id: 'st-prog', name: 'In Progress', type: 'started' }, labels: [{ id: 'lb-fe', name: 'Frontend' }], labelIds: ['lb-fe'], updatedAt: '2026-11-20T08:08:00.000Z' }), { updatedFrom: { title: 'Checkout times out', updatedAt: '2026-11-20T08:07:00.000Z' } })),
  comment2: await linear(linearEnvelope('Comment', 'create', comment('cm-2', 'dup, ignore', ADA, { createdAt: '2026-11-20T08:09:00.000Z', updatedAt: '2026-11-20T08:09:00.000Z' }))),
  remove: await linear(linearEnvelope('Comment', 'remove', comment('cm-2', 'dup, ignore', ADA, { updatedAt: '2026-11-20T08:10:00.000Z', archivedAt: '2026-11-20T08:10:00.000Z' }))),
  otherTeam: await linear(linearEnvelope('Issue', 'create', issue({ id: 'issue-ops', identifier: 'OPS-1', teamId: 'team-ops', team: { id: 'team-ops', key: 'OPS' } }))),
}
for (const [what, answers] of Object.entries(lsent)) log(what.padEnd(12) + answers.join('  |  '))

const linearRoot = await waitFor('the Linear root', async () => (await board('GET', '/sync/find?thread=' + encodeURIComponent('linear:issue:' + ISSUE))).thread)
const linearRootId = (await board('GET', '/sync/threads/' + encodeURIComponent(linearRoot))).root
const linearView = await waitFor('the Linear thread to settle', async () => {
  const view = await thread(linearRootId)
  return view.message.labels.state === 'In Progress' && view.message.text.includes('eu-west') && view.replies.length === 2 && view.replies[0].editedAt && view.replies[1].deleted ? view : null
})
log('\n# linear: the thread on the board')
log(JSON.stringify(show(linearView.message), null, 1))
for (const reply of linearView.replies) log(JSON.stringify(show(reply), null, 1))
const linearCounts = await counts('linear/eng')
log('events in linear/eng  ' + JSON.stringify(linearCounts))
check(JSON.stringify(linearView.message.labels) === JSON.stringify({ issue: 'ENG-42', state: 'In Progress', 'label.frontend': 'Frontend' }), 'the root' + "'" + 's labels are the issue' + "'" + 's: state In Progress, Frontend on, Bug off')
check(linearCounts['message.posted'] === 3 && linearCounts['message.edited'] === 2 && linearCounts['labels.changed'] === 1 && linearCounts['message.deleted'] === 1, 'each Linear delivery landed once: 3 posts, 2 edits, 1 label change, 1 delete')

log('\n# linear: a reply written on the board goes back as a comment, and its echo lands as nothing')
const lbefore = recorded.length
const linearReply = await board('POST', '/messages', { re: linearRootId, text: 'Rolled back the eu-west gateway config; watching p99.' })
log('board reply  #' + linearReply.message.id)
const linearSynced = await waitFor('the Linear receipt', async () => {
  const { targets } = await board('GET', '/messages/' + linearReply.message.id + '/sync')
  return targets.find((target) => target.message) ? targets : null
})
log('receipt  ' + JSON.stringify(linearSynced))
const mutations = recorded.slice(lbefore).filter((entry) => entry.path === '/linear/graphql')
for (const entry of mutations) log('linear got  POST ' + entry.path + '  auth=' + entry.authorization + '  ' + JSON.stringify(entry.body) + '  -> comment ' + entry.answered)
check(mutations.length === 1 && mutations[0].body.variables.input.issueId === ISSUE && mutations[0].authorization === process.env.LINEAR_API_KEY && /commentCreate/.test(mutations[0].body.query), 'one commentCreate on the issue, with the API key from the Worker secret')
check(linearSynced[0].message === 'comment-' + mutations[0]?.answered, 'the receipt records the comment Linear made')
const echo = await linear(linearEnvelope('Comment', 'create', comment(mutations[0].answered, 'Rolled back the eu-west gateway config; watching p99.', { id: 'lin-user-bot', name: 'Boards', type: 'user' }, { createdAt: '2026-11-20T08:11:00.000Z', updatedAt: '2026-11-20T08:11:00.000Z' }), { actor: { id: 'lin-user-bot', name: 'Boards', type: 'user' } }))
log('echo  ' + echo.join('  |  '))
await sleep(3000)
const linearAfter = await counts('linear/eng')
const afterLinear = await thread(linearRootId)
log('replies now  ' + afterLinear.replies.map((reply) => '#' + reply.id + ' ' + reply.author.name + (reply.deleted ? ' (deleted)' : '')).join(', '))
log('events in linear/eng  ' + JSON.stringify(linearAfter))
check(afterLinear.replies.length === 3 && linearAfter['message.posted'] === 4, 'the echo imported nothing')

log('\n# what the mock was asked, in all')
for (const entry of recorded) log(entry.method + ' ' + entry.path + (Object.keys(entry.query).length ? '?' + new URLSearchParams(entry.query) : ''))
mock.close()
log('\n' + (failures ? failures + ' failed' : 'all passed'))
process.exit(failures ? 1 : 0)
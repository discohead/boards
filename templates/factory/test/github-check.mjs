// Checks the factory's GitHub sync end to end under wrangler dev (test/wrangler.dev.jsonc): GitHub's
// webhooks signed as GitHub signs them, at the board's own /webhooks/github, each sent twice; a
// recording mock of GitHub's API (the app's installation token, and the comments it posts); and the
// board read back. An issue becomes a thread, a comment a reply, a reply written on the board one
// comment on the issue as the app, and GitHub's echo of that comment nothing.
//   GITHUB_WEBHOOK_SECRET=… node test/github-check.mjs
import { createHmac } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { fileURLToPath } from 'node:url'

const ORIGIN = process.env.ORIGIN ?? 'http://127.0.0.1:8813'
const SECRET = process.env.GITHUB_WEBHOOK_SECRET
if (!SECRET) throw new Error('set GITHUB_WEBHOOK_SECRET to what the Worker has')
const here = fileURLToPath(new URL('.', import.meta.url))
const config = readFileSync(here + '../src/config.ts', 'utf8')
const NAME = config.match(/export const NAME = '([^']+)'/)[1]
const REPO = config.match(/export const REPOS[^{]*\{\s*'([^']+)'/)[1]
const BOT = { id: 4242, login: NAME + '-test[bot]', type: 'Bot' }
const URL_ = ORIGIN + '/b/' + NAME
const TOKEN = execFileSync('node', ['scripts/issuer.mjs', 'token', 'jared', URL_], { cwd: here + '../../../packages/boards', encoding: 'utf8' }).trim()

const log = (...parts) => console.log(...parts)
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
let failures = 0
const check = (ok, what) => {
  if (!ok) failures++
  log((ok ? 'ok    ' : 'FAIL  ') + what)
}

// -- GitHub's API, mocked --------------------------------------------------------------------------
const recorded = []
let nextComment = 9001
const mock = createServer(async (req, res) => {
  let body = ''
  for await (const chunk of req) body += chunk
  const entry = { method: req.method, path: req.url, authorization: req.headers.authorization ?? '', body: body ? JSON.parse(body) : null }
  recorded.push(entry)
  const send = (status, value) => (res.writeHead(status, { 'content-type': 'application/json' }), res.end(JSON.stringify(value)))
  if (req.method === 'GET' && req.url === '/repos/' + REPO + '/installation') return send(200, { id: 77 })
  if (req.method === 'POST' && req.url === '/app/installations/77/access_tokens') return send(201, { token: 'ghs_installation_token_77', expires_at: new Date(Date.now() + 3600_000).toISOString() })
  const comment = req.url.match(new RegExp('^/repos/' + REPO + '/issues/(\\d+)/comments$'))
  if (req.method === 'POST' && comment) {
    const id = nextComment++
    entry.answered = id
    return send(201, { id, body: entry.body.body, user: BOT, html_url: 'https://github.test/' + REPO + '/issues/' + comment[1] + '#issuecomment-' + id })
  }
  send(404, { message: 'Not Found' })
})
await new Promise((resolve) => mock.listen(8814, '127.0.0.1', resolve))

// -- the board ------------------------------------------------------------------------------------
async function board(method, path, body) {
  const response = await fetch(URL_ + path, { method, headers: { authorization: 'Bearer ' + TOKEN, 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) })
  const text = await response.text()
  if (!response.ok) throw new Error(method + ' ' + path + ' answered ' + response.status + ': ' + text)
  return JSON.parse(text)
}
async function waitFor(what, fn, ms = 30_000) {
  const until = Date.now() + ms
  for (;;) {
    const value = await fn().catch(() => null)
    if (value) return value
    if (Date.now() > until) throw new Error('timed out waiting for ' + what)
    await sleep(250)
  }
}

/** A delivery, signed as GitHub signs one (sha256 HMAC of the body), sent as many times as asked: a redelivery has the same ID. */
async function deliver(event, payload, { times = 2, secret = SECRET } = {}) {
  const body = JSON.stringify({ ...payload, repository: { full_name: REPO, name: REPO.split('/')[1], owner: { login: REPO.split('/')[0] } } })
  const id = crypto.randomUUID()
  const answers = []
  for (let n = 0; n < times; n++) {
    const response = await fetch(URL_ + '/webhooks/github', { method: 'POST', headers: { 'content-type': 'application/json', 'x-github-event': event, 'x-github-delivery': id, 'x-hub-signature-256': 'sha256=' + createHmac('sha256', secret).update(body).digest('hex'), 'user-agent': 'GitHub-Hookshot/test' }, body })
    answers.push(response.status + ' ' + (await response.text()).trim())
  }
  return answers
}

const ADA = { id: 1001, login: 'ada', type: 'User', avatar_url: 'https://avatars.test/ada.png' }
log('board  ' + URL_ + '  repo  ' + REPO)
log('\n# webhooks')
log('discovery  ' + JSON.stringify((await board('GET', '/')).sync))
log('ping           ' + (await deliver('ping', { zen: 'Keep it logically awesome.', hook_id: 1 }, { times: 1 })).join(''))
log('forged         ' + (await deliver('issues', { action: 'opened', issue: { number: 7, title: 'forged', body: '', user: ADA, state: 'open' }, sender: ADA }, { times: 1, secret: 'not-the-secret' })).join(''))
log('issue opened   ' + (await deliver('issues', { action: 'opened', issue: { number: 7, title: 'Checkout times out', body: 'Requests to /checkout hang for 30s.', user: ADA, state: 'open' }, sender: ADA })).join('  |  '))
log('bot PR opened  ' + (await deliver('pull_request', { action: 'opened', pull_request: { number: 8, title: 'Fix the timeout', body: 'Closes #7', html_url: 'https://github.test/pr/8', draft: false, user: BOT, head: { repo: { fork: false } } }, sender: BOT })).join('  |  '))
log('fork PR opened ' + (await deliver('pull_request', { action: 'opened', pull_request: { number: 9, title: 'Drive-by', body: '', html_url: 'https://github.test/pr/9', draft: false, user: ADA, head: { repo: { fork: true } } }, sender: ADA })).join('  |  '))
log('comment        ' + (await deliver('issue_comment', { action: 'created', issue: { number: 7 }, comment: { id: 500, body: 'Seeing it in eu-west too.', user: ADA }, sender: ADA })).join('  |  '))

const thread = 'github:' + REPO + ':7'
const found = await waitFor('the issue' + "'" + 's thread', async () => (await board('GET', '/sync/find?thread=' + encodeURIComponent(thread))).thread)
const root = (await board('GET', '/sync/threads/' + encodeURIComponent(found))).root
const view = await waitFor('the comment', async () => {
  const value = await board('GET', '/messages/' + root)
  return value.replies.length === 1 ? value : null
})
log('\n# the thread on the board')
log('#' + view.message.id + '  ' + view.message.author.name + ' (' + view.message.by.actor + ')  ' + JSON.stringify(view.message.text) + '  ' + JSON.stringify(view.message.labels))
for (const reply of view.replies) log('#' + reply.id + '  ' + reply.author.name + ' (' + reply.by.actor + ')  ' + JSON.stringify(reply.text))
const others = await Promise.all([8, 9].map((n) => board('GET', '/sync/find?thread=' + encodeURIComponent('github:' + REPO + ':' + n))))
check(view.message.text.includes('Checkout times out') && view.replies.length === 1 && view.replies[0].text === 'Seeing it in eu-west too.', 'the issue is a thread and its comment a reply, once each')
check(others.every((other) => other.thread === null), 'no thread for the app' + "'" + 's own pull request, nor for a fork' + "'" + 's')

log('\n# a reply written on the board goes to GitHub as the app')
const before = recorded.length
const posted = await board('POST', '/messages', { re: root, text: 'Rolled back the eu-west gateway; watching p99.' })
log('board reply  #' + posted.message.id)
const synced = await waitFor('the receipt', async () => {
  const { targets } = await board('GET', '/messages/' + posted.message.id + '/sync')
  return targets.find((target) => target.message) ? targets : null
})
log('receipt  ' + JSON.stringify(synced))
for (const entry of recorded.slice(before)) log('github got  ' + entry.method + ' ' + entry.path + '  auth=' + entry.authorization.slice(0, 22) + (entry.authorization.length > 22 ? '…' : '') + (entry.body ? '  ' + JSON.stringify(entry.body) : '') + (entry.answered ? '  -> comment ' + entry.answered : ''))
const comments = recorded.filter((entry) => entry.method === 'POST' && /\/issues\/\d+\/comments$/.test(entry.path))
check(comments.length === 1 && comments[0].path === '/repos/' + REPO + '/issues/7/comments' && comments[0].authorization === 'Bearer ghs_installation_token_77' && comments[0].body.body === 'Rolled back the eu-west gateway; watching p99.', 'one POST /issues/7/comments, with the app' + "'" + 's installation token')
check(synced[0].message === 'comment-' + comments[0]?.answered, 'the receipt records the comment GitHub made')

log('\n# GitHub' + "'" + 's echo of that comment')
log('echo  ' + (await deliver('issue_comment', { action: 'created', issue: { number: 7 }, comment: { id: comments[0].answered, body: 'Rolled back the eu-west gateway; watching p99.', user: BOT }, sender: BOT })).join('  |  '))
await waitFor('the echo, drained', async () => (await board('GET', '/inbox/github?limit=50')).events.some((event) => event.id.startsWith('') && event.event?.message === 'comment-' + comments[0].answered && event.state === 'done'))
await sleep(1000)
const after = await board('GET', '/messages/' + root)
log('replies now  ' + after.replies.map((reply) => '#' + reply.id + ' ' + reply.author.name).join(', '))
check(after.replies.length === 2 && recorded.filter((entry) => /\/comments$/.test(entry.path)).length === 1, 'the echo imported nothing, and nothing more went to GitHub')
const inbox = (await board('GET', '/inbox/github?limit=50')).events
log('\n# the Inbox (newest first)')
for (const event of inbox) log(event.state.padEnd(7) + ' tries ' + event.attempts + '  ' + event.event.kind + ' ' + (event.event.message ?? '') + '  ' + event.id)

mock.close()
log('\n' + (failures ? failures + ' failed' : 'all passed'))
process.exit(failures ? 1 : 0)

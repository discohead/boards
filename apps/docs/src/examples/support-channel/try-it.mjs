// Tries the support desk under wrangler dev, with no Slack workspace: a stand-in for Slack's Web
// API on :8826 (SLACK_API_BASE points at it), a question sent to the board's Slack webhook signed
// as Slack signs it (twice, as Slack retries), and Slack's echo of the bot's reply sent back.
//   SLACK_SIGNING_SECRET=<what the Worker has> WORKBUS_URL=http://127.0.0.1:8825/b/support WORKBUS_TOKEN=<token> node try-it.mjs
import { createHmac } from 'node:crypto'
import { createServer } from 'node:http'

const { SLACK_SIGNING_SECRET, WORKBUS_URL, WORKBUS_TOKEN } = process.env
const CHANNEL = 'C0SUPPORT'
const BOT = 'U0BOT'
const QUESTION_TS = String(Math.floor(Date.now() / 1000)) + '.000100'
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

// Slack's Web API, as much of it as the provider calls.
const posted = []
const stand = createServer(async (request, response) => {
  let body = ''
  for await (const chunk of request) body += chunk
  const method = new URL(request.url, 'http://slack').pathname.split('/').pop()
  const send = (value) => response.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(value))
  if (method === 'users.info') return send({ ok: true, user: { id: 'U0ADA', name: 'ada', real_name: 'Ada Lovelace', profile: { display_name: 'Ada' } } })
  if (method === 'chat.postMessage') {
    const message = JSON.parse(body)
    const ts = String(Math.floor(Date.now() / 1000)) + '.000200'
    posted.push({ ...message, ts })
    send({ ok: true, channel: message.channel, ts })
    // Slack echoes the bot's own message back as an event: the board already has it.
    setTimeout(() => void slack('Ev' + ts, { type: 'message', channel: message.channel, user: BOT, text: message.text, ts, thread_ts: message.thread_ts }), 200)
    return
  }
  send({ ok: false, error: 'unknown_method' })
})
await new Promise((resolve) => stand.listen(8826, '127.0.0.1', resolve))

/** An Events API delivery, signed as Slack signs it. */
async function slack(id, event) {
  const body = JSON.stringify({ type: 'event_callback', team_id: 'T0TEAM', event_id: id, event_time: Math.floor(Date.now() / 1000), event })
  const stamp = String(Math.floor(Date.now() / 1000))
  const signature = 'v0=' + createHmac('sha256', SLACK_SIGNING_SECRET).update('v0:' + stamp + ':' + body).digest('hex')
  const response = await fetch(WORKBUS_URL + '/webhooks/slack', { method: 'POST', headers: { 'content-type': 'application/json', 'x-slack-request-timestamp': stamp, 'x-slack-signature': signature }, body })
  return response.status + ' ' + (await response.text()).trim()
}
const board = (path) => fetch(WORKBUS_URL + path, { headers: { authorization: 'Bearer ' + WORKBUS_TOKEN } }).then((response) => response.json())

const question = { type: 'message', channel: CHANNEL, user: 'U0ADA', text: "I was charged twice for November and can't find a refund option", ts: QUESTION_TS }
console.log('webhook       ' + (await slack('EvQUESTION' + QUESTION_TS, question)))
console.log('retried       ' + (await slack('EvQUESTION' + QUESTION_TS, question)))

// The thread on the board, once the agent has answered and its reply is on Slack.
let thread
for (let tries = 0; tries < 120; tries++) {
  await sleep(500)
  const found = await board('/sync/find?thread=' + encodeURIComponent('slack:' + CHANNEL + ':' + QUESTION_TS))
  if (!found.thread || posted.length === 0) continue
  const root = (await board('/sync/threads/' + encodeURIComponent(found.thread))).root
  thread = await board('/messages/' + root)
  if (thread.replies.length) break
}
await sleep(1500)
thread = await board('/messages/' + thread.message.id)
console.log('board thread  #' + thread.message.id + ' ' + JSON.stringify(thread.message.labels) + ', ' + thread.replies.length + ' reply by ' + thread.replies.map((reply) => reply.by.actor).join(', '))
console.log('to slack      ' + posted.map((message) => message.channel + ' thread ' + message.thread_ts + ': ' + message.text).join('\n              '))
stand.close()

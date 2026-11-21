// The Slack and Linear providers' own checks, with no board: a request's signature and age, the
// secrets accessor, and what each platform's payload means on the board.
//   node --test test/sync/providers.node-test.ts
import assert from 'node:assert/strict'
import { createHmac } from 'node:crypto'
import { test } from 'node:test'
import { githubProvider } from '../../src/sync/github.ts'
import { linearEvents, verifyLinear } from '../../src/sync/linear.ts'
import { readSecret } from '../../src/sync/secrets.ts'
import { linkTargets } from '../../src/sync/links.ts'
import { fromSlack, slackEvents, toSlack, verifySlack } from '../../src/sync/slack.ts'

const SLACK_SECRET = '8f742231b10e8888abcd99yyyzzz85a5'
const LINEAR_SECRET = 'lin_wh_abcdefghijklmnopqrstuvwxyz0123456789'
const NOW = 1_763_600_000_000

/** A request signed as Slack signs one: v0=hex(HMAC-SHA256(secret, "v0:<ts>:<body>")). */
function slackRequest(body: string, { secret = SLACK_SECRET, at = NOW, signature }: { secret?: string; at?: number; signature?: string } = {}) {
  const stamp = String(Math.floor(at / 1000))
  const sig = signature ?? 'v0=' + createHmac('sha256', secret).update('v0:' + stamp + ':' + body).digest('hex')
  return new Request('http://board.test/webhooks/slack', { method: 'POST', headers: { 'x-slack-request-timestamp': stamp, 'x-slack-signature': sig, 'content-type': 'application/json' }, body })
}

/** A delivery signed as Linear signs one: hex(HMAC-SHA256(secret, raw body)), sent at webhookTimestamp. */
function linearRequest(payload: Record<string, unknown>, { secret = LINEAR_SECRET, sentAt = NOW }: { secret?: string; sentAt?: number } = {}) {
  const body = JSON.stringify({ ...payload, webhookTimestamp: sentAt })
  return new Request('http://board.test/webhooks/linear', { method: 'POST', headers: { 'linear-signature': createHmac('sha256', secret).update(body).digest('hex'), 'content-type': 'application/json' }, body })
}

const event = JSON.stringify({ type: 'event_callback', event_id: 'Ev1', event: { type: 'message', channel: 'C1', user: 'U1', text: 'hi', ts: '1.000100' } })

test('slack: a request signed with the secret, now, is verified', async () => {
  const verified = await verifySlack(slackRequest(event), SLACK_SECRET, NOW)
  assert.equal(verified.ok, true)
  assert.equal(verified.ok && verified.payload.event_id, 'Ev1')
})

test('slack: one signed with another secret, or a changed body, is not', async () => {
  assert.deepEqual(await verifySlack(slackRequest(event, { secret: 'not-the-secret' }), SLACK_SECRET, NOW), { ok: false, reason: 'signature' })
  const good = slackRequest(event)
  const tampered = new Request(good.url, { method: 'POST', headers: good.headers, body: event.replace('hi', 'ho') })
  assert.deepEqual(await verifySlack(tampered, SLACK_SECRET, NOW), { ok: false, reason: 'signature' })
  assert.deepEqual(await verifySlack(slackRequest(event, { signature: '' }), SLACK_SECRET, NOW), { ok: false, reason: 'signature' })
})

test('slack: a signature over a timestamp more than 5 minutes off is stale, either way', async () => {
  assert.equal((await verifySlack(slackRequest(event, { at: NOW - 299_000 }), SLACK_SECRET, NOW)).ok, true)
  assert.deepEqual(await verifySlack(slackRequest(event, { at: NOW - 301_000 }), SLACK_SECRET, NOW), { ok: false, reason: 'stale' })
  assert.deepEqual(await verifySlack(slackRequest(event, { at: NOW + 301_000 }), SLACK_SECRET, NOW), { ok: false, reason: 'stale' })
  const none = new Request('http://board.test/', { method: 'POST', headers: { 'x-slack-signature': 'v0=00' }, body: event })
  assert.deepEqual(await verifySlack(none, SLACK_SECRET, NOW), { ok: false, reason: 'stale' })
})

test('linear: a delivery signed with the secret, sent in the last minute, is verified', async () => {
  const verified = await verifyLinear(linearRequest({ type: 'Issue', action: 'create', data: { id: 'i1' } }), LINEAR_SECRET, NOW + 59_000)
  assert.equal(verified.ok, true)
  assert.equal(verified.ok && verified.payload.data.id, 'i1')
})

test('linear: one signed with another secret, or a changed body, is not', async () => {
  assert.deepEqual(await verifyLinear(linearRequest({ type: 'Issue' }, { secret: 'other' }), LINEAR_SECRET, NOW), { ok: false, reason: 'signature' })
  const good = linearRequest({ type: 'Issue', action: 'create' })
  const body = (await good.clone().text()).replace('create', 'remove')
  assert.deepEqual(await verifyLinear(new Request(good.url, { method: 'POST', headers: good.headers, body }), LINEAR_SECRET, NOW), { ok: false, reason: 'signature' })
})

test('linear: a webhookTimestamp more than a minute off, or none, is stale', async () => {
  assert.deepEqual(await verifyLinear(linearRequest({ type: 'Issue' }, { sentAt: NOW - 61_000 }), LINEAR_SECRET, NOW), { ok: false, reason: 'stale' })
  assert.deepEqual(await verifyLinear(linearRequest({ type: 'Issue' }, { sentAt: NOW + 61_000 }), LINEAR_SECRET, NOW), { ok: false, reason: 'stale' })
  const body = JSON.stringify({ type: 'Issue' })
  const unstamped = new Request('http://board.test/', { method: 'POST', headers: { 'linear-signature': createHmac('sha256', LINEAR_SECRET).update(body).digest('hex') }, body })
  assert.deepEqual(await verifyLinear(unstamped, LINEAR_SECRET, NOW), { ok: false, reason: 'stale' })
})

test('secrets: a Worker secret is its string; a Secrets Store binding is what get() reads', async () => {
  assert.equal(await readSecret('plain'), 'plain')
  assert.equal(await readSecret({ get: async () => 'from-store' }), 'from-store')
  await assert.rejects(readSecret(undefined, 'the Slack bot token'), /the Slack bot token is not configured/)
  await assert.rejects(readSecret({ get: async () => { throw new Error('secret not found') } }, 'x'), /x: Secrets Store couldn't read it: secret not found/)
  await assert.rejects(readSecret('', 'y'), /y is empty/)
})

test('github: its webhook secret can be a Secrets Store binding too', async () => {
  const provider = githubProvider({ webhookSecret: { get: async () => 'gh-secret' }, repos: {} })
  const ping = (secret: string) => {
    const body = JSON.stringify({ zen: 'hi' })
    return new Request('http://board.test/', { method: 'POST', headers: { 'x-github-event': 'ping', 'x-hub-signature-256': 'sha256=' + createHmac('sha256', secret).update(body).digest('hex') }, body })
  }
  const good = await provider.receive(ping('gh-secret'), { key: 'github' })
  assert.deepEqual([good.events, good.response?.status], [[], 200])
  assert.equal((await provider.receive(ping('other'), { key: 'github' })).response?.status, 401)
})

const slackOptions = { signingSecret: 's', channels: { C1: 'slack/general' }, botUserId: 'UBOT' }
const wrap = (inner: Record<string, unknown>) => ({ type: 'event_callback', event_id: 'Ev', event: inner })

test('slack: a message is a root, a thread reply a reply, in a mapped channel only', () => {
  assert.deepEqual(slackEvents(wrap({ type: 'message', channel: 'C1', user: 'U1', text: 'hello <@U2>', ts: '1.1' }), slackOptions).map((e) => [e.kind, 'thread' in e ? e.thread : null, 'mentioned' in e ? e.mentioned : null]), [['root', 'slack:C1:1.1', ['U2']]])
  assert.deepEqual(slackEvents(wrap({ type: 'message', channel: 'C1', user: 'U1', text: 'r', ts: '1.2', thread_ts: '1.1' }), slackOptions).map((e) => [e.kind, 'thread' in e ? e.thread : null]), [['reply', 'slack:C1:1.1']])
  assert.deepEqual(slackEvents(wrap({ type: 'message', channel: 'C9', user: 'U1', text: 'r', ts: '1.2' }), slackOptions), [])
  assert.deepEqual(slackEvents(wrap({ type: 'message', subtype: 'channel_join', channel: 'C1', user: 'U1', text: 'joined', ts: '1.3' }), slackOptions), [])
  const own = slackEvents(wrap({ type: 'message', channel: 'C1', user: 'UBOT', bot_id: 'B1', text: 'r', ts: '1.4', thread_ts: '1.1' }), slackOptions)[0]!
  assert.equal(own.kind === 'reply' && own.own, true)
})

test('slack: an edit that kept its text is nothing; a tombstone is a delete; a reaction names its message', () => {
  const changed = (text: string, before: string, extra = {}) => wrap({ type: 'message', subtype: 'message_changed', channel: 'C1', message: { user: 'U1', text, ts: '1.2', thread_ts: '1.1', ...extra }, previous_message: { user: 'U1', text: before, ts: '1.2', thread_ts: '1.1' } })
  assert.deepEqual(slackEvents(changed('same', 'same'), slackOptions), [])
  assert.deepEqual(slackEvents(changed('new', 'old'), slackOptions).map((e) => [e.kind, 'thread' in e ? e.thread : null, e.ts]), [['edit', 'slack:C1:1.1', '1.2']])
  assert.deepEqual(slackEvents(changed('This message was deleted.', 'old', { subtype: 'tombstone' }), slackOptions).map((e) => e.kind), ['delete'])
  assert.deepEqual(slackEvents(wrap({ type: 'message', subtype: 'message_deleted', channel: 'C1', deleted_ts: '1.2', previous_message: { ts: '1.2', thread_ts: '1.1', user: 'U1' } }), slackOptions).map((e) => [e.kind, 'thread' in e ? e.thread : null]), [['delete', 'slack:C1:1.1']])
  assert.deepEqual(slackEvents(wrap({ type: 'reaction_added', user: 'U2', reaction: 'thumbsup::skin-tone-3', item: { type: 'message', channel: 'C1', ts: '1.2' } }), slackOptions).map((e) => [e.kind, e.kind === 'react' && e.emoji]), [['react', 'thumbsup']])
})

test('slack: text both ways', () => {
  assert.deepEqual(fromSlack('see <https://a.test/x?y=1&amp;z=2|the doc> &amp; ask <@U2> in <#C1|general> &lt;now&gt;'), { text: 'see [the doc](https://a.test/x?y=1&z=2) & ask @[slack:user:U2] in #general <now>', mentioned: ['U2'] })
  assert.equal(toSlack('a < b & @[worker:workbus-slack+slack:user:U2]'), 'a &lt; b &amp; <@U2>')
})

const linearOptions = { webhookSecret: 's', teams: { ENG: 'linear/eng' }, botUserId: 'lbot' }

test('linear: an issue in a mapped team is a root with its state and labels; its comments are replies', () => {
  const issue = { id: 'i1', identifier: 'ENG-7', title: 'Crash', description: 'It crashes.', team: { id: 't1', key: 'ENG' }, state: { name: 'Todo' }, labels: [{ name: 'Bug' }, { name: 'Needs Triage' }] }
  const [root] = linearEvents({ type: 'Issue', action: 'create', data: issue, actor: { id: 'u1', name: 'Ada' } }, linearOptions)
  assert.equal(root!.kind, 'root')
  assert.deepEqual(root!.kind === 'root' && root.labels, { issue: 'ENG-7', state: 'Todo', 'label.bug': 'Bug', 'label.needs-triage': 'Needs Triage' })
  assert.deepEqual(linearEvents({ type: 'Issue', action: 'create', data: { ...issue, team: { id: 't2', key: 'OPS' } } }, linearOptions), [])
  const update = linearEvents({ type: 'Issue', action: 'update', data: issue, updatedFrom: { stateId: 's0' } }, linearOptions)
  assert.deepEqual(update.map((e) => e.kind), ['labels'])
  assert.deepEqual(linearEvents({ type: 'Issue', action: 'update', data: issue, updatedFrom: { title: 'Old' } }, linearOptions).map((e) => e.kind), ['edit'])
  const comment = { id: 'c1', body: 'Seen it.', issueId: 'i1', userId: 'u2', user: { id: 'u2', name: 'Bo' } }
  assert.deepEqual(linearEvents({ type: 'Comment', action: 'create', data: comment }, linearOptions).map((e) => [e.kind, e.thread, 'message' in e ? e.message : null]), [['reply', 'linear:issue:i1', 'comment-c1']])
  assert.deepEqual(linearEvents({ type: 'Comment', action: 'remove', data: comment }, linearOptions).map((e) => e.kind), ['delete'])
  const own = linearEvents({ type: 'Comment', action: 'create', data: { ...comment, userId: 'lbot' } }, linearOptions)[0]!
  assert.equal(own.kind === 'reply' && own.own, true)
})
test("Slack: the bot's own reaction is the courier's echo, a person's is an event", () => {
  const options = { signingSecret: 's', botToken: 't', channels: { C1: 'slack/general' }, botUserId: 'UBOT' }
  const reaction = (user: string) => ({ type: 'event_callback', event_id: 'Ev' + user, event: { type: 'reaction_added', user, reaction: 'rocket', item: { type: 'message', channel: 'C1', ts: '1.000100' } } })
  assert.deepEqual(slackEvents(reaction('UBOT'), options as never, 'slack'), [])
  assert.equal(slackEvents(reaction('UPERSON'), options as never, 'slack').length, 1)
})

test('links: what a GitHub, Slack, or Linear link names', () => {
  const [gh] = linkTargets('https://github.com/acme/web/pull/7#discussion_r55') as any[]
  assert.equal(gh.thread('github'), 'github:acme/web:7')
  assert.equal(gh.message, 'rc-55')
  const [slack] = linkTargets('https://acme.slack.com/archives/C0123/p1700000001000200?thread_ts=1700000000.000100') as any[]
  assert.equal(slack.thread('slack'), 'slack:C0123:1700000000.000100')
  assert.equal(slack.message, '1700000001.000200')
  const [linear] = linkTargets('https://linear.app/acme/issue/eng-42/checkout-times-out#comment-0b1d') as any[]
  assert.deepEqual([linear.issue, linear.comment], ['ENG-42', 'comment-0b1d'])
  assert.deepEqual(linkTargets('https://example.com/x'), [])
  assert.deepEqual(linkTargets('not a url'), [])
})

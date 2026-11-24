#!/usr/bin/env node
// Rewrites src/data/openapi.json from a running board. It starts nothing: point it at a board you
// already run (wrangler dev, or a deployment), with a token for it.
//
//   node scripts/refresh-openapi.mjs <board url> <token> [--force]
//   node scripts/refresh-openapi.mjs http://127.0.0.1:8822/b/acme "$(cd ../../packages/workbus && node scripts/issuer.mjs token jared http://127.0.0.1:8822/b/acme)"
//
// What it writes:
//   - every route of the board's route table (packages/workbus/src/protocol/*.ts), with its path and
//     query parameters and request body as JSON Schema, converted from the route's own zod schema;
//   - for each route, one request and the answer the board gave it, from a scripted run against the
//     board: posts, replies, tasks and claims, grants, schedules, files, watchers, sync, inbox, MCP;
//   - the board's MCP tools, as its tools/list answers them.
// It also checks the board's own GET /openapi.json against the route table and prints what it misses.
//
// The run writes to the board (channels deploys, work, support, and more), so give it a fresh board:
// it refuses one that already has channels of its own, unless you pass --force.
import { registerHooks } from 'node:module'
import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const OUT = join(here, '..', 'src', 'data', 'openapi.json')
const SRC = join(here, '..', '..', '..', 'packages', 'workbus', 'src')
const PUBLIC_ORIGIN = 'https://workbus.example.com'

const args = process.argv.slice(2)
const force = args.includes('--force')
const [boardUrl, token] = args.filter((arg) => !arg.startsWith('--'))
if (!boardUrl || !token) {
  console.error('usage: node scripts/refresh-openapi.mjs <board url> <token> [--force]')
  process.exit(2)
}
const BOARD = boardUrl.replace(/\/+$/, '')
const ORIGIN = new URL(BOARD).origin

// -- the route table, from the source ------------------------------------------------------------

// The protocol modules import cloudflare:workers (for RpcTarget and the entrypoints); in Node they
// get stand-ins, since only the route definitions are read here.
const STUB = 'data:text/javascript,' + encodeURIComponent('export class RpcTarget {}; export class WorkerEntrypoint {}; export class DurableObject {}; export const exports = {}; export const env = {}')
registerHooks({
  resolve(specifier, context, next) {
    if (specifier === 'cloudflare:workers') return { url: STUB, shortCircuit: true }
    return next(specifier, context)
  },
})
const { ROUTES } = await import(pathToFileURL(join(SRC, 'protocol', 'routes.ts')).href)
await import(pathToFileURL(join(SRC, 'protocol', 'index.ts')).href)
const { VERSION } = await import(pathToFileURL(join(SRC, 'gateway', 'gateway.ts')).href)
// The zod the protocol modules load: packages/workbus' own.
const { z } = await import(pathToFileURL(join(SRC, '..', 'node_modules', 'zod', 'index.js')).href)

const DOMAINS = [
  ['board', 'Board', 'Discovery, who you are, and who is on the board.'],
  ['channels', 'Channels', 'The channels a caller can read, making one, and archiving one.'],
  ['messages', 'Messages', 'Posting, replying, and changing a message.'],
  ['threads', 'Threads', 'A thread read whole, and threads found by filters.'],
  ['events', 'Events', 'The feed: every event, in order, as a page, a held wait, or a stream.'],
  ['follows', 'Follows', 'What reaches a caller: the threads and doc discussions it follows.'],
  ['reads', 'Read state', "What's unread for a caller, and marking it read."],
  ['tasks', 'Tasks', 'Threads with a state, claimed under a lease and fenced by epoch and token.'],
  ['docs', 'Docs', 'Threads with a Markdown body, read and edited by section.'],
  ['schedules', 'Schedules', 'Posting later, once or on a repeat.'],
  ['files', 'Files', 'Uploading and reading attachments, kept on R2.'],
  ['grants', 'Grants', 'Who may do what, where.'],
  ['schemas', 'Schemas', 'The registry that structured blocks are checked against.'],
  ['watchers', 'Watchers', 'Registered watchers: register, pull matches, ack.'],
  ['wakes', 'Wakes', 'Registered watchers the board delivers, to a service sink its deployment declares.'],
  ['sync', 'Sync', 'What a sync imports and records, and where a thread syncs.'],
  ['inbox', 'Inbox', 'The platform events a sync holds, pulled one platform thread at a time.'],
  ['archive', 'Archive', "Where a board's history stands, and its archival settings."],
  ['rpc', 'RPC', "The Board capability over Cap'n Web."],
  ['mcp', 'MCP', 'The board as MCP tools.'],
]

const DOMAIN = {
  discovery: 'board', openapi: 'board', avatar: 'board', me: 'board', setName: 'board', actors: 'board', hideActor: 'board',
  channels: 'channels', createChannel: 'channels', archiveChannel: 'channels', unarchiveChannel: 'channels',
  channelMessages: 'messages', post: 'messages', posted: 'messages', edit: 'messages', delete: 'messages', react: 'messages', label: 'messages', typing: 'messages',
  message: 'threads', threads: 'threads',
  events: 'events',
  follow: 'follows', follows: 'follows',
  unread: 'reads', markRead: 'reads',
  createDoc: 'docs', docAt: 'docs', doc: 'docs', editDoc: 'docs', moveDoc: 'docs', docProposal: 'docs', docHistory: 'docs', docDiff: 'docs', docBacklinks: 'docs',
  schedule: 'schedules', schedules: 'schedules', cancelSchedule: 'schedules',
  upload: 'files', attachment: 'files', uploadStart: 'files', uploadFinish: 'files',
  grants: 'grants', createGrant: 'grants', createGrants: 'grants', updateGrant: 'grants', revokeGrant: 'grants', explainGrants: 'grants',
  schemas: 'schemas', schema: 'schemas', createSchema: 'schemas',
  register: 'watchers', watchers: 'watchers', matches: 'watchers', ack: 'watchers',
  setWake: 'wakes', wakes: 'wakes', deleteWake: 'wakes',
  syncImport: 'sync', syncReceipt: 'sync', syncThread: 'sync', syncFind: 'sync', syncCopies: 'sync', synced: 'sync', sync: 'sync', linked: 'sync', webhook: 'sync',
  inbox: 'inbox', inboxPush: 'inbox', inboxReplay: 'inbox', inboxNext: 'inbox', inboxAck: 'inbox',
  archive: 'archive', configureArchive: 'archive', fillArchive: 'archive',
  rpc: 'rpc', rpcBatch: 'rpc',
  mcp: 'mcp', mcpStream: 'mcp',
}
const domainOf = (name) => DOMAIN[name] ?? (name.toLowerCase().includes('task') ? 'tasks' : null)

// One line per route: what it does. The route table carries no prose, so it lives here.
const SUMMARY = {
  discovery: "The board's version, URL, token audience, and syncs.",
  openapi: "The board's own list of routes, by path, with no schemas. It misses routes that share a path: see the end of this page.",
  avatar: 'A mark for a name with no picture of its own: its initial on a color from the name, as SVG. No token; cached a day. A name is lowercase letters, digits, and hyphens, up to 32.',
  me: 'Who the token is, and what it may do in each channel it can reach.',
  setName: 'Set the display name the board shows for you (a person, without a profile).',
  actors: 'Everyone who has written on the board: people, Workers, profiles, and platform users. Hidden ones only with ?hidden=true.',
  hideActor: "Hide an actor from the board's lists and @mention settling, or show it again (manage at *). Its messages keep their author; it shows again if it writes.",
  channels: 'The channels this caller can read, a page at a time.',
  createChannel: 'Makes an empty channel. 201 when it is new, 200 when it was there.',
  archiveChannel: 'Archives a channel (eng) or a subtree (checks/): out of GET /channels and unread, and no new posts there (409 channel_archived). Needs manage where it reaches.',
  unarchiveChannel: 'Unarchives a channel or a subtree, and every pattern archived inside it; still says what wider pattern archives it yet.',
  channelMessages: "One channel's messages, oldest first.",
  post: 'Starts a thread in a channel, or replies in one (re).',
  posted: 'A post by the client ID it was written with.',
  edit: "Replaces a message's text. Only its author may.",
  delete: 'Deletes a message. It stays in its thread as a tombstone. As moderation (manage in its channel, as yourself): anyone\'s, or your own with moderation: true; a root takes its replies, and nothing wakes.',
  react: 'Adds a reaction, or takes yours back with remove.',
  label: "Sets and unsets a message's labels; if makes the write conditional.",
  typing: 'Shows typing in the platform threads the thread is synced to. Writes nothing.',
  message: 'A thread: its root and replies, from the ID of any message in it.',
  threads: 'Threads by filters, newest activity first.',
  events: 'A page of the feed after a cursor. wait holds the call open; Accept: text/event-stream streams it.',
  follow: 'Follows what a message is in (its thread, or on a doc, its discussion), or unfollows it with on: false. Read access is enough.',
  follows: "The caller's follows, newest first: each thread, or discussion on a doc, and why.",
  unread: "Every unread count at once: each channel with threads others started since the caller read it, or mentions, and each followed thread with replies that reached it. channel (or a subtree) narrows it, and lists that channel at zero.",
  markRead: 'Marks a channel or a thread read: up to now, or up to a message ID or cursor (upto). Writes nothing to the log.',
  tasks: 'Tasks by state, channel, label, owner, and what they wait for.',
  createTask: "Starts a thread as a task, or makes an existing thread one (re). claim: true claims it in the same write.",
  createTasks: 'Up to 100 tasks in one channel, in one write, with needs between them by key.',
  createdTasks: 'The tasks a batch made, by the batch client ID.',
  claimReadyTask: 'Claims the oldest ready task in a channel or subtree. wait holds the call until one is ready.',
  claimTask: 'Claims one task by ID.',
  renewTask: 'Extends a claim: the lease runs again from now.',
  releaseTask: 'Gives a claim up. The task is ready again.',
  completeTask: 'Completes a claimed task, with an optional result.',
  failTask: 'Fails a claimed task, with a reason. Its owner may reopen it.',
  blockTask: 'Holds a task for a person: with a claim (which ends), or as its owner.',
  unblockTask: 'Lifts a hold on a task you own.',
  reopenTask: 'Makes a failed or canceled task ready again.',
  assignTask: "Lets one actor claim it (one of the owner's profiles), or anyone (null).",
  setTaskNeeds: 'Replaces the tasks it waits for.',
  cancelTask: 'Cancels a task you own. Tasks that wait for it keep waiting.',
  createDoc: "Makes a doc at channel/slug from its Markdown body, or from another doc as a template (from). With re, an existing thread's root becomes the doc where it is (a task gains a body). Needs post and edit in the channel.",
  docAt: 'The doc at a path (docs/runbooks/deploy), read as GET /docs/{id} reads it.',
  doc: "A doc's view and its body; with section, that section only; with revision, as it was then. depth sets how deep the outline goes (3 by default).",
  editDoc: 'Edits a doc by section, checked per section against the revision you read, or as a whole body (merge: true merges by section). propose: true makes the edit a task instead.',
  moveDoc: 'Moves a doc to a new channel, slug, or both. Its ID, its replies, and every link to it stay. Needs edit in both channels.',
  docProposal: "A proposal's change, read and not applied: a new doc's path and body, or a change's doc, its body now, the body it would have, and whether applying it would be refused (stale).",
  docHistory: "A doc's versions, oldest first: who, when, and which sections each edit changed.",
  docDiff: 'The sections that changed between two revisions, before and after (to: now).',
  docBacklinks: 'The threads, replies, and docs whose text links the doc, by its path or ID.',
  schedule: 'Posts later, once (in, at) or on a repeat (every, until, for, times).',
  schedules: 'Pending schedules this caller can see, oldest first.',
  cancelSchedule: 'Cancels a schedule, so it sends nothing more.',
  upload: 'Uploads a file of up to 4 MiB as the raw body. The answer is the attachment to name in a write.',
  attachment: "A file's bytes, as uploaded, with its name and type.",
  uploadStart: 'Direct uploads. This board answers 501 no_direct_uploads: upload through POST /attachments.',
  uploadFinish: 'Finishes a direct upload. No upload ticket is ever issued, so every ID answers 404.',
  grants: "The board's grants. Needs manage at *.",
  createGrant: 'Grants principals permissions in channels.',
  createGrants: 'Up to 16 grants in one write.',
  updateGrant: "Adds or removes a grant's principals, or replaces its can.",
  revokeGrant: 'Revokes a grant. Its principals are judged without it from their next request.',
  explainGrants: 'What a principal (you, when none is named) may do in a channel, and which grants say so.',
  schemas: 'The schemas blocks are checked against: the built-ins, then the board\'s own.',
  schema: 'One schema, by name@version.',
  createSchema: 'Registers a schema. Needs manage at *.',
  register: "Registers this token's watchers (and its sync entries), replacing any it had.",
  watchers: "This token's registration.",
  matches: "Pulls this token's pending matches, each under a lease. wait holds the call (up to 25 s).",
  ack: 'Acks a match by its lease: done, skipped, or failed with an error to retry.',
  setWake: 'Sets a wake for this caller (its profile and narrowing too) at a sink its deployment declares, by key: an upsert, ordered by revision. 404 sink_not_found, 403 sink_forbidden.',
  wakes: "This principal's wakes (every one, with manage at *).",
  deleteWake: 'Removes a wake, unless revision is older than the one it holds.',
  syncImport: "Imports a platform's post, edit, delete, reaction, labels, or links, as that platform's user.",
  syncReceipt: 'Records what a sync did with a message: its copy, its files, a failure, or a thread it attached.',
  syncThread: 'Where a board thread syncs: its targets and their platform threads.',
  syncFind: 'The board thread or message a platform thread, message, or client ID maps to.',
  syncCopies: 'The platform copies of up to 100 messages, by target.',
  synced: 'Where one message syncs, and whether each copy landed.',
  sync: 'Attaches a thread to a sync target, so what is written in it is copied there.',
  linked: "The thread of the board message a GitHub, Slack, or Linear link names, from sync's records alone (the platform is never asked): a link to a platform message finds its board copy, and a link to a platform thread finds its root. 404 message_not_found when nothing here was synced for it.",
  webhook: "A platform's webhook for one of the board's own syncs, verified by its provider. 404 no_sync for a key the deployment doesn't sync.",
  inbox: 'What a sync inbox holds, newest first, raw payloads included.',
  inboxPush: "Keeps up to 50 platform events in this token's inbox for a sync key.",
  inboxReplay: "Gives the failed events of one of the board's own syncs five fresh tries. Needs manage everywhere.",
  inboxNext: 'Pulls the next event of each platform thread, each under a lease.',
  inboxAck: 'Acks an inbox event by its lease: done, or failed with an error to retry.',
  archive: "Where the board's history stands: hot, sealed, and cold. Needs manage everywhere.",
  configureArchive: "Changes the board's archival settings, or runs a pass now. Needs manage everywhere.",
  fillArchive: 'Writes a bench history fast. Only where ARCHIVE_BENCH is 1.',
  rpc: "The Board capability over a Cap'n Web WebSocket (send Upgrade: websocket).",
  rpcBatch: "The Board capability over a Cap'n Web HTTP batch.",
  mcp: 'MCP over streamable HTTP: JSON-RPC 2.0 in, JSON out. Stateless.',
  mcpStream: 'No server-to-client stream: answers 405, Allow: POST.',
}

// Bodies the route table can't express as JSON Schema (a transform over unknown). Kept in step by hand.
const BODY_OVERRIDES = {
  createTasks: {
    type: 'object',
    properties: {
      channel: { type: 'string', maxLength: 2048, pattern: '^[a-z0-9][a-z0-9_-]*(?:\\/[a-z0-9][a-z0-9_-]*)*$' },
      tasks: {
        type: 'array', minItems: 1, maxItems: 100,
        items: {
          type: 'object',
          properties: {
            key: { type: 'string', minLength: 1, description: 'Names the task inside the batch, so another can need it as { key }.' },
            text: { type: 'string' },
            labels: { type: 'object', additionalProperties: { type: 'string', maxLength: 256 } },
            noSync: { type: 'boolean' },
            attachments: { type: 'array', items: { type: 'string' } },
            needs: { type: 'array', items: { anyOf: [{ type: 'string', minLength: 1, maxLength: 128, description: 'A task ID on the board.' }, { type: 'object', properties: { key: { type: 'string' } }, required: ['key'], additionalProperties: false }] } },
            for: { anyOf: [{ type: 'string', minLength: 1, maxLength: 256 }, { type: 'null' }] },
          },
          required: ['text'],
        },
      },
      id: { type: 'string', minLength: 1, maxLength: 200 },
      request: { type: 'string', minLength: 1, maxLength: 64 },
    },
    required: ['channel', 'tasks'],
  },
}
// Routes whose body the board doesn't read, or reads as bytes.
const NO_BODY = new Set(['unblockTask', 'reopenTask', 'cancelSchedule', 'uploadFinish'])

const jsonSchema = (schema, io) => {
  const out = z.toJSONSchema(schema, { io, unrepresentable: 'any' })
  delete out.$schema
  return out
}

/** The messages of a schema's refinements: the rules JSON Schema can't say. */
function rulesOf(schema) {
  const out = []
  const visit = (node, depth) => {
    const def = node?._zod?.def
    if (!def || depth > 4) return
    for (const check of def.checks ?? []) {
      if (check._zod?.def?.check !== 'custom') continue
      const error = check._zod.def.error
      let message = typeof error === 'function' ? error({ input: undefined, code: 'custom' }) : error
      if (message && typeof message === 'object') message = message.message
      if (typeof message === 'string' && message) out.push((check._zod.def.path?.length ? check._zod.def.path.join('.') + ': ' : '') + message)
    }
    if (def.type === 'pipe') visit(def.in, depth + 1)
  }
  visit(schema, 0)
  return [...new Set(out)].map((rule) => rule.replace(/\u0060/g, '\u0060'))
}

// -- talking to the board ------------------------------------------------------------------------

const auth = { authorization: 'Bearer ' + token }
const examples = {}
const errorExamples = {}
const routeByName = Object.fromEntries(ROUTES.map((route) => [route.name, route]))

function pathOf(name, params = {}) {
  const route = routeByName[name]
  if (!route) throw new Error('no route ' + name)
  return route.path.replace(/:(\w+)/g, (_, key) => {
    if (params[key] === undefined) throw new Error(name + ': no ' + key)
    return encodeURIComponent(params[key])
  })
}

function search(query) {
  const out = new URLSearchParams()
  for (const [key, value] of Object.entries(query ?? {})) for (const one of Array.isArray(value) ? value : [value]) if (one !== undefined) out.append(key, String(one))
  const text = out.toString()
  return text ? '?' + text : ''
}

const publish = (value) => JSON.parse(JSON.stringify(value).replaceAll(ORIGIN, PUBLIC_ORIGIN))

/** Calls a route as the token's caller and keeps the exchange as the route's example. */
async function call(name, { params, query, body, bytes, headers = {}, open = false, expect, keep = true } = {}) {
  const route = routeByName[name]
  const path = pathOf(name, params) + search(query)
  const sent = { ...headers }
  if (body !== undefined) sent['content-type'] = 'application/json'
  const response = await fetch(BOARD + path, { method: route.method, headers: { ...(open ? {} : auth), ...sent }, body: bytes ?? (body !== undefined ? JSON.stringify(body) : undefined) })
  const type = response.headers.get('content-type') ?? ''
  const text = await response.text()
  let answer = text
  if (type.includes('json') && text) answer = JSON.parse(text)
  const wanted = expect ?? (response.ok ? response.status : null)
  if (wanted === null || response.status !== wanted) {
    console.error(route.method + ' ' + path + ' answered ' + response.status + ': ' + text.slice(0, 300))
    throw new Error(name + ' failed')
  }
  const kept = {
    request: { method: route.method, path, ...(Object.keys(sent).length ? { headers: sent } : {}), ...(body !== undefined ? { body } : {}), ...(bytes !== undefined ? { bytes: typeof bytes === 'string' ? bytes : '<' + bytes.byteLength + ' bytes>' } : {}), ...(open ? { open: true } : {}) },
    status: response.status,
    ...(['retry-after', 'allow', 'content-disposition', 'content-security-policy'].some((h) => response.headers.has(h)) || !type.includes('json') ? { headers: Object.fromEntries([...response.headers].filter(([key]) => ['content-type', 'content-disposition', 'content-security-policy', 'x-content-type-options', 'cache-control', 'retry-after', 'allow'].includes(key))) } : {}),
    ...(text ? { response: answer } : {}),
  }
  if (process.env.DEBUG) console.error(name, response.status, text.slice(0, 400))
  if (keep) {
    const into = response.ok ? examples : errorExamples
    into[name] ??= publish(kept)
  }
  return answer
}

async function mcp(message) {
  const response = await fetch(BOARD + '/mcp', { method: 'POST', headers: { ...auth, 'content-type': 'application/json', accept: 'application/json, text/event-stream' }, body: JSON.stringify(message) })
  return response.status === 202 ? null : response.json()
}

// -- the run ---------------------------------------------------------------------------------------

const served = await (await fetch(BOARD + '/openapi.json')).json()
const discovery = await call('discovery', { open: true })
await call('openapi', { open: true })

const listed = await call('channels', { keep: false })
const ours = new Set(['deploys', 'work', 'support', 'ops', 'docs'])
const theirs = (listed.channels ?? []).map((channel) => channel.path ?? channel).filter((path) => !ours.has(String(path).split('/')[0]))
if (theirs.length && !force) {
  console.error('this board has channels of its own (' + theirs.slice(0, 5).join(', ') + '): the run writes to it, so give it a fresh board, or pass --force')
  process.exit(1)
}

const me = await call('me')
await call('avatar', { params: { name: me.handle }, open: true })
await call('setName', { body: { name: 'Jared' } })

// Watchers first: a registration sees what comes after it.
await call('register', { body: { watch: { deploys: { tail: 'deploys' } }, sync: [{ key: 'tracker', platform: 'tracker' }] } })
await call('watchers')

// Wakes: this board's deployment declares no sinks, so a wake is refused here.
await call('setWake', { body: { key: 'ada', sink: 'wake', rules: { mention: 'mention', queue: { ready: 'work/' } }, revision: 1 }, headers: { 'x-board-profile': 'ada' }, expect: 404 })
await call('wakes')
await call('deleteWake', { params: { key: 'ada' } })

await call('createChannel', { body: { path: 'deploys' }, expect: 201 }).catch(() => call('createChannel', { body: { path: 'deploys' } }))
await call('channels')

// Archiving: a channel made for it, archived, listed with archived=true, refused a post, and back.
await call('post', { body: { channel: 'ops/old', text: 'the last word here' }, keep: false })
await call('archiveChannel', { body: { path: 'ops/old' } })
await call('channels', { query: { archived: 'true', prefix: 'ops/' }, keep: false })
await call('post', { body: { channel: 'ops/old', text: 'one more' }, expect: 409 })
await call('unarchiveChannel', { body: { path: 'ops/old' } })
const posted = await call('post', { body: { channel: 'deploys', text: 'v42 is live on production', labels: { env: 'production' }, id: 'deploy-v42' } })
const root = posted.message.id
await call('posted', { params: { id: 'deploy-v42' } })
const replied = await call('post', { body: { re: root, text: 'smoke tests pass', after: root }, headers: { 'x-board-profile': 'checker' } })
await call('post', { body: { re: root, text: 'too late', after: root }, expect: 409 })
await call('edit', { params: { id: root }, body: { text: 'v42 is live on production (eu and us)', revision: posted.message.revision } })
await call('react', { params: { id: root }, body: { emoji: 'eyes' } })
await call('label', { params: { id: root }, body: { set: { status: 'verified' }, if: { status: null } } })
await call('typing', { params: { id: root }, body: { status: 'checking the canary' } })
const wrong = await call('post', { body: { channel: 'deploys', text: 'v41 is live (wrong build)' }, keep: false })
await call('delete', { params: { id: wrong.message.id }, body: {} })
await call('channelMessages', { query: { channel: 'deploys', limit: 2 } })
await call('message', { params: { id: replied.message.id } })
await call('threads', { query: { channel: 'deploys', label: 'env=production', limit: 10 } })
await call('actors')
const shownBy = await call('post', { body: { channel: 'support', text: 'an old test identity says hi' }, headers: { 'x-board-profile': 'retired' }, keep: false })
await call('hideActor', { body: { actor: shownBy.message.by.actor } })
await call('follow', { params: { id: replied.message.id }, body: {} })
await call('follows', { query: { limit: 5 } })
await call('post', { body: { channel: 'deploys', text: 'v42 needs a changelog entry, @[' + me.actor + ']' }, headers: { 'x-board-profile': 'checker' }, keep: false })
await call('unread')
await call('markRead', { body: { channel: 'deploys' } })
const page = await call('events', { query: { channel: 'deploys', last: 2 } })
await call('events', { query: { after: page.cursor, wait: 0 }, keep: false })

// Tasks.
const rotate = await call('createTask', { body: { channel: 'work', text: 'rotate the staging keys', labels: { area: 'infra' } } })
const batch = await call('createTasks', { body: { channel: 'work', id: 'release-42', tasks: [{ key: 'build', text: 'build v42' }, { key: 'ship', text: 'ship v42', needs: [{ key: 'build' }] }] } })
await call('createdTasks', { params: { id: 'release-42' } })
await call('tasks', { query: { channel: 'work', state: 'open' } })
const claimed = await call('claimReadyTask', { body: { channel: 'work', lease: 900 } })
const rotateId = claimed.task.id
await call('renewTask', { params: { id: rotateId }, body: { epoch: claimed.claim.epoch, token: claimed.claim.token, lease: 1800 } })
await call('releaseTask', { params: { id: rotateId }, body: { epoch: claimed.claim.epoch, token: claimed.claim.token } })
const again = await call('claimTask', { params: { id: rotateId }, body: { lease: 600 } })
await call('completeTask', { params: { id: rotateId }, body: { epoch: again.claim.epoch, token: again.claim.token, result: 'rotated; the old keys are revoked' } })
await call('completeTask', { params: { id: rotateId }, body: { epoch: again.claim.epoch, token: again.claim.token }, expect: 409 })
const [build, ship] = batch.tasks.map((task) => task.id ?? task.message?.id ?? task.task?.id)
const building = await call('claimTask', { params: { id: build }, body: {}, keep: false })
await call('failTask', { params: { id: build }, body: { epoch: building.claim.epoch, token: building.claim.token, reason: 'the build ran out of disk' } })
await call('reopenTask', { params: { id: build }, body: {} })
await call('blockTask', { params: { id: build }, body: { reason: 'a person approves each release', kind: 'approval' } })
await call('unblockTask', { params: { id: build }, body: {} })
await call('assignTask', { params: { id: ship }, body: { for: me.principal + '+shipper' } })
await call('setTaskNeeds', { params: { id: ship }, body: { needs: [build] } })
await call('cancelTask', { params: { id: ship }, body: { reason: 'v42 ships with the next train' } })
// A task gains a body: its thread's root becomes a doc where it is.
await call('createDoc', { body: { re: rotateId, slug: 'rotate-staging-keys', body: '# Rotate the staging keys\n\n## Steps\n\nRotate, then revoke the old keys.\n' }, keep: false })

// Docs.
const runbook = 'How we ship the web app.\n\n## Ship\n\nRun the deploy from main.\n\n### Rollback\n\nRoll back to the previous version by its ID.\n\n## Monitoring\n\nWatch the error rate for an hour.\n'
const madeDoc = await call('createDoc', { body: { channel: 'docs/runbooks', slug: 'deploy', body: runbook, labels: { owner: 'ops' } } })
const docId = madeDoc.message.id
const docRevision = madeDoc.message.doc.revision
await call('docAt', { query: { path: 'docs/runbooks/deploy' } })
await call('doc', { params: { id: docId }, query: { section: 'ship/rollback' } })
const edited = await call('editDoc', { params: { id: docId }, body: { revision: docRevision, edits: [{ section: 'ship/rollback', text: '\nRoll back with deploy rollback <id>, the ID of the last green version.\n\n' }] } })
await call('editDoc', { params: { id: docId }, body: { revision: docRevision, edits: [{ section: 'ship/rollback', text: '\nRoll back fast.\n\n' }] }, expect: 409 })
await call('post', { body: { channel: 'deploys', text: 'v43 rolled back, per [[docs/runbooks/deploy#ship/rollback]]' }, keep: false })
await call('moveDoc', { params: { id: docId }, body: { channel: 'docs/ops', slug: 'shipping' } })
const proposed = await call('editDoc', { params: { id: docId }, body: { revision: (await call('doc', { params: { id: docId }, keep: false })).doc.revision, edits: [{ section: 'monitoring', text: '\nWatch the error rate and p95 latency for an hour.\n\n' }], propose: true, note: 'We missed a latency regression in v41.' }, keep: false })
await call('docProposal', { params: { id: proposed.proposal.id } })
await call('docHistory', { params: { id: docId } })
await call('docDiff', { params: { id: docId }, query: { from: docRevision, to: edited.revision } })
await call('docBacklinks', { params: { id: docId } })

// Schedules.
const scheduled = await call('schedule', { body: { channel: 'ops', text: 'standup in five minutes', every: '1d', times: 5 } })
await call('schedules', { query: { channel: 'ops' } })
await call('cancelSchedule', { params: { id: scheduled.schedule?.id ?? scheduled.id } })

// Files.
const uploaded = await call('upload', { bytes: 'build 42: ok\n', headers: { 'content-type': 'text/plain', 'x-board-filename': 'build.log' } })
const attachmentId = uploaded.attachment?.id ?? uploaded.id
await call('attachment', { params: { id: attachmentId } })
await call('post', { body: { re: root, text: 'the build log', attachments: [attachmentId] }, keep: false })
await call('uploadStart', { body: { name: 'trace.zip', type: 'application/zip', size: 50 * 1024 * 1024 }, expect: 501 })
await call('uploadFinish', { params: { id: 'u1' }, body: {}, expect: 404 })

// Grants.
await call('grants')
const granted = await call('createGrant', { body: { principals: [{ kind: 'github', repository: 'acme/web', branch: 'main' }], can: { deploys: ['read', 'post'] } } })
const grantId = granted.grant?.id ?? granted.id
await call('updateGrant', { params: { id: grantId }, body: { can: { deploys: ['read', 'post', 'react'] } } })
await call('explainGrants', { query: { channel: 'deploys', github: 'acme/web', branch: 'main' } })
const many = await call('createGrants', { body: { grants: [{ principals: [{ kind: 'worker', script: 'deployer' }], can: { deploys: ['post'] } }, { principals: [{ kind: 'all-users' }], can: { 'work/': ['read'] } }] } })
await call('revokeGrant', { params: { id: grantId }, body: {} })
for (const grant of many.grants ?? []) await call('revokeGrant', { params: { id: grant.id }, body: {}, keep: false })

// Schemas.
await call('schemas')
await call('createSchema', { body: { name: 'release', version: 1, description: 'A release, as a deploy posts it.', schema: { type: 'object', properties: { version: { type: 'string' }, sha: { type: 'string' } }, required: ['version'] } } })
await call('schema', { params: { id: 'release@1' } })

// Watchers' matches.
const pulled = await call('matches', { query: { limit: 1 } })
const match = pulled.matches?.[0]
if (match) await call('ack', { params: { id: match.id }, body: { lease: match.lease } })

// Sync, as a registrant whose sync key is tracker.
const grace = { id: 'tracker:u1', handle: 'grace', name: 'Grace', avatar: null, isBot: false }
const imported = await call('syncImport', { body: { op: 'post', author: grace, from: 'tracker', origin: { channel: 'tracker:eng', thread: 'tracker:eng/T-12', message: 'tracker:c1' }, channel: 'support', text: 'the export button does nothing', id: 'T-12' } })
const issue = imported.message
await call('sync', { params: { id: issue }, body: { target: 'tracker:eng/T-12' } })
const answer = await call('post', { body: { re: issue, text: 'fixed in v43' }, keep: false })
await call('syncReceipt', { body: { kind: 'message', message: answer.message.id, target: 'tracker:eng/T-12', external: { thread: 'tracker:eng/T-12', message: 'tracker:c2' } } })
await call('synced', { params: { id: answer.message.id } })
const thread = (await call('message', { params: { id: issue }, keep: false })).message?.thread ?? issue
await call('syncThread', { params: { thread } })
await call('syncFind', { query: { thread: 'tracker:eng/T-12', message: 'tracker:c1' } })
await call('syncCopies', { query: { message: answer.message.id } })
await call('linked', { query: { url: 'https://tracker.example.com/T-12' }, expect: 404 })
await call('webhook', { params: { key: 'github' }, open: true, body: {}, expect: 404 })

// The inbox, as the same registrant.
const event = { kind: 'message', channel: 'tracker:eng', thread: 'tracker:eng/T-12', subthread: null, message: 'tracker:c3', isRoot: false, text: 'still broken on Safari', context: null, author: grace }
await call('inboxPush', { params: { key: 'tracker' }, body: { events: [{ id: 'evt-3', event, raw: { comment: 'c3' } }] } })
await call('inbox', { params: { key: 'tracker' }, query: { limit: 5 } })
const next = await call('inboxNext', { params: { key: 'tracker' } })
const item = next.items?.[0]
if (item) await call('inboxAck', { params: { key: 'tracker', id: item.id }, body: { lease: item.lease } })
await call('inboxReplay', { params: { key: 'tracker' }, body: {}, expect: 404 })

// Archive.
await call('archive')
await call('configureArchive', { body: {} })
await call('fillArchive', { body: { channel: 'bench', threads: 10, replies: 2 }, expect: 501 })

// RPC and MCP.
await call('rpc', { expect: 426 })
{
  // One HTTP batch, made by capnweb's own client; the exchange is kept as the board saw it.
  const { newHttpBatchRpcSession } = await import(pathToFileURL(join(SRC, '..', 'node_modules', 'capnweb', 'dist', 'index.js')).href)
  const real = globalThis.fetch
  globalThis.fetch = async (input, init) => {
    const request = new Request(input, init)
    const sent = await request.clone().text()
    const response = await real(request)
    const text = await response.clone().text()
    examples.rpcBatch ??= publish({ request: { method: 'POST', path: '/rpc', headers: { 'content-type': 'text/plain' }, bytes: sent }, status: response.status, headers: { 'content-type': response.headers.get('content-type') }, response: text })
    return response
  }
  try {
    const board = newHttpBatchRpcSession(new Request(BOARD + '/rpc', { headers: auth }))
    await board.me()
  } finally {
    globalThis.fetch = real
  }
}
await call('mcpStream', { expect: 405 })
const initialize = { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'docs', version: '1' } } }
await call('mcp', { body: initialize })
const tools = (await mcp({ jsonrpc: '2.0', id: 2, method: 'tools/list' })).result.tools
const toolCalls = {}
toolCalls.board_search = { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'board_search', arguments: { channel: 'deploys', limit: 1 } } }
toolCalls.board_read = { jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'board_read', arguments: { id: root, limit: 1 } } }
toolCalls.board_post = { jsonrpc: '2.0', id: 5, method: 'tools/call', params: { name: 'board_post', arguments: { channel: 'deploys', text: 'v43 is rolling out', id: 'deploy-v43' } } }
toolCalls.board_reply = { jsonrpc: '2.0', id: 6, method: 'tools/call', params: { name: 'board_reply', arguments: { id: root, text: 'canary is healthy' } } }
toolCalls.board_unread = { jsonrpc: '2.0', id: 12, method: 'tools/call', params: { name: 'board_unread', arguments: {} } }
toolCalls.board_mark_read = { jsonrpc: '2.0', id: 13, method: 'tools/call', params: { name: 'board_mark_read', arguments: { channel: 'deploys' } } }
toolCalls.doc_search = { jsonrpc: '2.0', id: 8, method: 'tools/call', params: { name: 'doc_search', arguments: { channel: 'docs/' } } }
toolCalls.doc_read = { jsonrpc: '2.0', id: 9, method: 'tools/call', params: { name: 'doc_read', arguments: { path: 'docs/ops/shipping', section: 'ship/rollback' } } }
toolCalls.doc_create = { jsonrpc: '2.0', id: 10, method: 'tools/call', params: { name: 'doc_create', arguments: { channel: 'docs/specs', slug: 'search', body: '## Goal\n\nFind any doc by a word in it.\n' } } }
toolCalls.run_code = { jsonrpc: '2.0', id: 7, method: 'tools/call', params: { name: 'run_code', arguments: { code: 'async () => {\n  const { threads } = await board.threads({ channel: "deploys", limit: 5 })\n  return threads.filter((t) => !t.message.deleted).map((t) => t.message.text)\n}' } } }
const toolExamples = {}
for (const [name, message] of Object.entries(toolCalls)) toolExamples[name] = publish({ request: message, response: await mcp(message) })
{
  // doc_edit with the revision the doc is at now, as an agent sends it after doc_read.
  const now = (await call('doc', { params: { id: docId }, query: { depth: 1 }, keep: false })).doc.revision
  const message = { jsonrpc: '2.0', id: 11, method: 'tools/call', params: { name: 'doc_edit', arguments: { path: 'docs/ops/shipping', revision: now, edits: [{ section: 'monitoring', text: '\nWatch the error rate and p95 latency for an hour.\n' }] } } }
  toolExamples.doc_edit = publish({ request: message, response: await mcp(message) })
}

// -- the document ------------------------------------------------------------------------------------

const ERROR = {
  type: 'object',
  properties: { error: { type: 'object', properties: { code: { type: 'string' }, message: { type: 'string' }, hint: { type: 'string' }, data: { type: 'object' } }, required: ['code', 'message'] } },
  required: ['error'],
}

const paths = {}
for (const route of ROUTES) {
  const path = route.path.replace(/:(\w+)/g, '{$1}')
  const parameters = (route.path.match(/:(\w+)/g) ?? []).map((part) => ({ name: part.slice(1), in: 'path', required: true, schema: { type: 'string' } }))
  if (route.query) {
    const schema = jsonSchema(route.query, 'input')
    const required = new Set(schema.required ?? [])
    for (const [name, value] of Object.entries(schema.properties ?? {})) parameters.push({ name, in: 'query', required: required.has(name), schema: value })
  }
  const operation = { operationId: route.name, tags: [domainOf(route.name)], summary: SUMMARY[route.name] ?? '', 'x-order': ROUTES.indexOf(route) }
  if (!SUMMARY[route.name]) console.error('no summary for ' + route.name)
  operation.security = route.open ? [] : [{ bearer: [] }]
  if (route.gateway) operation['x-gateway'] = true
  if (parameters.length) operation.parameters = parameters
  const rules = [...(route.query ? rulesOf(route.query) : []), ...(route.body ? rulesOf(route.body) : [])]
  if (rules.length) operation['x-rules'] = rules
  if (route.name === 'upload') operation.requestBody = { required: true, content: { '*/*': { schema: { type: 'string', format: 'binary' } } }, 'x-headers': { 'content-type': "The file's media type.", 'x-board-filename': 'Its name, URI-encoded.' } }
  else if (BODY_OVERRIDES[route.name]) operation.requestBody = { required: true, content: { 'application/json': { schema: BODY_OVERRIDES[route.name] } } }
  else if (route.body && !NO_BODY.has(route.name)) {
    const schema = jsonSchema(route.body, 'input')
    if (schema.type === 'object' || schema.anyOf || schema.oneOf) operation.requestBody = { required: !route.optionalBody, content: { 'application/json': { schema } } }
  }
  const example = examples[route.name]
  const failed = errorExamples[route.name]
  const responses = {}
  const ok = route.status === 201 ? '201' : '200'
  if (example) responses[String(example.status)] = { description: example.status === 201 ? 'Created' : 'OK' }
  else if (!failed || route.status) responses[ok] = { description: ok === '201' ? 'Created' : 'OK' }
  if (route.status === 'created') responses['201'] = { description: 'Created: it is new' }
  if (failed) responses[String(failed.status)] = { description: failed.response?.error?.code ?? 'Error', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } }
  responses.default = { description: 'An error', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } }
  operation.responses = responses
  if (example) operation['x-example'] = example
  if (failed) operation['x-error-example'] = failed
  paths[path] ??= {}
  paths[path][route.method.toLowerCase()] = operation
}

// What the board's own document misses.
const missing = []
for (const route of ROUTES) {
  const path = route.path.replace(/:(\w+)/g, '{$1}')
  if (!served.paths?.[path]?.[route.method.toLowerCase()]) missing.push(route.method + ' ' + path + ' (' + route.name + ')')
}
const unexampled = ROUTES.filter((route) => !examples[route.name] && !errorExamples[route.name]).map((route) => route.name)

const doc = {
  openapi: '3.1.0',
  info: { title: 'Workbus', version: VERSION, description: 'Protocol v1 of a board, served at /b/{board} on a Workbus Worker.' },
  servers: [{ url: PUBLIC_ORIGIN + '/b/{board}', variables: { board: { default: 'acme' } } }],
  tags: DOMAINS.map(([name, title, description]) => ({ name, 'x-displayName': title, description })),
  paths,
  components: {
    securitySchemes: { bearer: { type: 'http', scheme: 'bearer', bearerFormat: 'JWT', description: "A token signed for this board's URL: the board's issuer, GitHub Actions OIDC, an OIDC issuer a grant names, or Cloudflare Access." } },
    schemas: { Error: ERROR },
  },
  'x-captured': { version: VERSION, discovery: publish(discovery), missingFromServedDocument: missing },
  'x-mcp': { tools, examples: toolExamples },
}

writeFileSync(OUT, JSON.stringify(doc, null, 2) + '\n')
console.log('wrote ' + OUT.replace(process.cwd() + '/', ''))
console.log(ROUTES.length + ' routes, ' + Object.keys(examples).length + ' examples, ' + Object.keys(errorExamples).length + ' error examples, ' + tools.length + ' MCP tools')
if (unexampled.length) console.log('no example for: ' + unexampled.join(', '))
if (missing.length) console.log("the board's GET /openapi.json misses " + missing.length + ' routes:\n  ' + missing.join('\n  '))

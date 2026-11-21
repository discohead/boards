// The Board capability: the board as objects, for a Worker that binds it, a Cap'n Web client, and
// Code Mode's sandbox. A Board holds one verified caller and calls the Ledger directly with it, each
// input checked against the protocol's own route schemas first, so every method is the same request
// the Gateway would make. Attenuation is a method: as(profile), narrow(can), and channel(pattern)
// answer a new Board that can do no more than this one and the narrowing both allow. A Claim holds
// its token server-side and is already fenced; dropping or disposing its stub leaves the claim held.
//
// Two entrypoints hand a Board out:
//   Workbus        another Worker's service binding, with props { board?, principal, can?, profile? }:
//                 the binding is the credential, and it acts as worker:<principal>.
//   BoardSession  the Board a Gateway caller already holds, handed to a Dynamic Worker (Code Mode):
//                 its props are sealed with the board's issuer key, so no one else can mint one.
import { RpcTarget, WorkerEntrypoint } from 'cloudflare:workers'
import { WorkbusError, failureOf, type Failure } from './errors.ts'
import { canMap, canText, decide, parseCan, parsePattern, type Can, type Grant } from './ledger/access.ts'
import type { Caller, Principal } from './ledger/core.ts'
import { Bell, validationFailure, type GatewayEnv, type LedgerStub, type Mount } from './gateway/gateway.ts'
import { parseProfile } from './gateway/headers.ts'
import { ROUTES } from './protocol/routes.ts'
import type { IssuerKey } from './gateway/auth.ts'

export type BindingEnv = GatewayEnv

/** Where a Board's calls go: the board, the caller the Ledger trusts, and the region its waits ring in. */
type Seat = { env: BindingEnv; name: string; caller: Caller; mount: Mount | undefined; region: string }

const SUB = /^[a-z0-9](?:[a-z0-9._@-]{0,62}[a-z0-9])?$/
const BOARD_NAME = /^[a-z0-9][a-z0-9_-]{0,63}$/

/** A failure as it crosses RPC: an Error whose message leads with the board's code. */
function crossing(failure: Failure): Error {
  const error = new Error(failure.code + ': ' + failure.message + (failure.hint ? ' (' + failure.hint + ')' : ''))
  error.name = 'WorkbusError'
  return error
}
const refuse = (status: number, code: string, message: string) => crossing({ status, code, message })

const isPlain = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value)

/** A query as the route's schema reads it: strings, as a URL carries them. { status: 'open' } labels are key=value. */
function asQuery(input: unknown): Record<string, unknown> {
  if (input === undefined || input === null) return {}
  if (!isPlain(input)) throw refuse(400, 'invalid_request', 'pass an object of options')
  const out: Record<string, unknown> = {}
  const text = (value: unknown) => (typeof value === 'number' || typeof value === 'boolean' ? String(value) : value)
  for (const [key, value] of Object.entries(input)) {
    if (value === undefined) continue
    if (key === 'label' && isPlain(value)) out.label = Object.entries(value).map(([name, wanted]) => (wanted === null || wanted === true ? name : name + '=' + String(wanted)))
    else out[key] = Array.isArray(value) ? value.map(text) : text(value)
  }
  return out
}

/** A method's input checked as the Gateway checks its request: the route's body or query, then its path parameters. */
function checked(method: string, input: unknown, params: Record<string, unknown> = {}): Record<string, unknown> {
  const route = ROUTES.find((entry) => entry.name === method)
  if (!route) throw refuse(404, 'not_found', 'no method ' + method)
  for (const [key, value] of Object.entries(params))
    if (typeof value !== 'string' || value.length === 0 || value.length > 128) throw refuse(400, 'invalid_request', key + ': a message ID is a string of 1 to 128 characters')
  let parsed: unknown = {}
  if (route.query) {
    const result = route.query.safeParse(asQuery(input))
    if (!result.success) throw crossing(validationFailure(result.error).toFailure())
    parsed = result.data
  } else if (route.body) {
    const body = input === undefined && route.optionalBody ? {} : input
    const result = route.body.safeParse(body)
    if (!result.success) throw crossing(validationFailure(result.error).toFailure())
    parsed = result.data
  }
  return { ...(parsed as object), ...params }
}

const noMount = () => refuse(500, 'no_mount', "this board hasn't been served at its URL yet, so it doesn't know its own address: set BOARD_ORIGIN, or make one request to it first")

/** Calls one protocol method as the seat's caller: the Ledger decides, and a refusal is thrown. */
async function call<T = any>(seat: Seat, method: string, input: Record<string, unknown>): Promise<T> {
  const expires = seat.caller.principal.expiresAt
  if (expires !== null && expires <= Date.now()) throw refuse(401, 'unauthorized', 'the token this capability came from has expired: authenticate again')
  const ledger = seat.env.LEDGER.getByName(seat.name) as unknown as LedgerStub
  let answer: Awaited<ReturnType<LedgerStub['call']>>
  try {
    answer = await ledger.call(seat.caller, method, input, seat.mount)
  } catch (error) {
    if (error instanceof Error && error.message.includes('served nothing yet')) throw noMount()
    throw crossing(failureOf(error))
  }
  if (!answer.ok) {
    if (answer.failure.code === 'no_mount') throw noMount()
    throw crossing(answer.failure)
  }
  return answer.value as T
}

/** A method asked with no wait, and again after each ring of the board's Relay, until it has something or the wait ends. */
async function held<T>(seat: Seat, method: string, input: Record<string, unknown>, wait: number, found: (value: T) => boolean, next: (value: T, asked: Record<string, unknown>) => Record<string, unknown>): Promise<T> {
  let asked: Record<string, unknown> = { ...input, wait: 0 }
  let value = await call<T>(seat, method, asked)
  if (wait <= 0 || found(value)) return value
  const deadline = Date.now() + wait * 1000
  const bell = new Bell(seat.env, seat.name, seat.region)
  try {
    await bell.open()
    for (;;) {
      asked = next(value, asked)
      value = await call<T>(seat, method, asked)
      if (found(value) || Date.now() >= deadline) return value
      await bell.ring(deadline)
    }
  } finally {
    bell.close()
  }
}

const PROBE = (pattern: string) => (pattern === '*' ? '\u0000any' : pattern.endsWith('/') ? pattern + '\u0000child' : pattern)

/** What both narrowings allow, as one: in every channel, the permissions each gives there, intersected. */
export function within(held: Record<string, Grant> | null, more: Record<string, Grant>): Record<string, Grant> {
  if (!held) return more
  const out: Record<string, Grant> = {}
  for (const pattern of new Set([...Object.keys(held), ...Object.keys(more)])) {
    const a = decide(held, PROBE(pattern)) ?? []
    const b = decide(more, PROBE(pattern)) ?? []
    out[pattern] = a.filter((permission) => b.includes(permission))
  }
  return out
}

/** A can as data or as x-board-can text, checked: { 'work/': ['read', 'post'] }, 'work/=read,post', or 'all'. */
function canOf(can: unknown): Record<string, Grant> {
  try {
    if (typeof can === 'string') return can === 'all' ? { '*': 'all' } : parseCan(can, 'can')
    if (Array.isArray(can) || isPlain(can)) {
      const map = canMap(can as Can)
      for (const pattern of Object.keys(map)) parsePattern(pattern)
      return parseCan(canText(map), 'can')
    }
  } catch (error) {
    if (error instanceof WorkbusError) throw crossing(error.toFailure())
    throw error
  }
  throw refuse(400, 'invalid_can', "pass a can, like { 'work/': ['read', 'post'] } or 'work/=read,post'")
}

function profileOf(profile: unknown) {
  const name = typeof profile === 'string' ? profile : isPlain(profile) && typeof profile.name === 'string' ? profile.name : null
  if (name === null) throw refuse(400, 'invalid_profile', "pass a profile's name, or { name, avatar }")
  const avatar = isPlain(profile) ? profile.avatar : undefined
  if (avatar !== undefined && typeof avatar !== 'string') throw refuse(400, 'invalid_profile', 'avatar is an https URL')
  try {
    return parseProfile(name + (avatar !== undefined ? ';avatar=' + JSON.stringify(avatar) : ''))
  } catch (error) {
    if (error instanceof WorkbusError) throw crossing(error.toFailure())
    throw error
  }
}

/** A post's input: its text, or the object POST /messages takes, without where it goes. */
function message(input: unknown, where: Record<string, unknown>): Record<string, unknown> {
  if (typeof input === 'string') return { ...where, text: input }
  if (!isPlain(input)) throw refuse(400, 'invalid_request', 'pass the text, or { text, labels, attachments, id }')
  if ('channel' in input || 're' in input) throw refuse(400, 'invalid_request', "where it goes is the method's first argument, not the input's")
  return { ...input, ...where }
}

const options = (value: unknown): Record<string, unknown> => {
  if (value === undefined || value === null) return {}
  if (!isPlain(value)) throw refuse(400, 'invalid_request', 'pass an object of options')
  return value
}

/** The board as one caller. Holding it is the permission; it never widens. */
export class Board extends RpcTarget {
  #seat: Seat
  constructor(seat: Seat) {
    super()
    this.#seat = seat
  }

  /** The board's name. */
  get name(): string {
    return this.#seat.name
  }

  /** Who this is and what it may do where: GET /me. */
  me(query?: { prefix?: string; after?: string; limit?: number }) {
    return call(this.#seat, 'me', checked('me', query))
  }

  /** The same caller, writing as profile: actor <principal>+<profile>. What it may do doesn't change. */
  as(profile: string | { name: string; avatar?: string }): Board {
    return new Board({ ...this.#seat, caller: { ...this.#seat.caller, profile: profileOf(profile) } })
  }

  /** The same caller, held to can as well: { 'work/': ['read', 'post'] } or 'work/=read,post'. It never widens. */
  narrow(can: Can | string): Board {
    return new Board({ ...this.#seat, caller: { ...this.#seat.caller, narrow: within(this.#seat.caller.narrow, canOf(can)) } })
  }

  /** The same caller, held to one channel ('deploys') or a channel and its subtree ('work/'). */
  channel(pattern: string): Board {
    if (typeof pattern !== 'string') throw refuse(400, 'invalid_can', "pass a channel ('deploys') or a channel and its subtree ('work/')")
    return this.narrow({ [pattern]: 'all' })
  }

  /** Starts a thread in channel. */
  post(channel: string, input: string | Record<string, unknown>) {
    return call(this.#seat, 'post', checked('post', message(input, { channel })))
  }

  /** Replies in the thread of id (any message in it). */
  reply(id: string, input: string | Record<string, unknown>) {
    return call(this.#seat, 'post', checked('post', message(input, { re: id })))
  }

  /** A thread: its root and replies, from a message ID: GET /messages/:id. */
  message(id: string, range?: { after?: string; limit?: number }) {
    return call(this.#seat, 'message', checked('message', range, { id }))
  }

  /** The same as message(id): a thread, read. */
  read(id: string, range?: { after?: string; limit?: number }) {
    return this.message(id, range)
  }

  /** A post by the client ID it was written with, or 404: GET /posts/:id. */
  posted(clientId: string) {
    return call(this.#seat, 'posted', checked('posted', undefined, { id: clientId }))
  }

  /** Threads, newest activity first, by filters (channel, by, mentions, label, text, from). */
  threads(query?: Record<string, unknown>) {
    return call(this.#seat, 'threads', checked('threads', query))
  }

  /** One channel's messages, oldest first: GET /messages?channel=. */
  messages(channel: string, range?: { after?: string; limit?: number }) {
    return call(this.#seat, 'channelMessages', checked('channelMessages', { ...options(range), channel }))
  }

  /** The channels this caller can read. */
  channels(query?: { prefix?: string; after?: string; limit?: number }) {
    return call(this.#seat, 'channels', checked('channels', query))
  }

  edit(id: string, text: string, opts?: { revision?: number }) {
    return call(this.#seat, 'edit', checked('edit', { ...options(opts), text }, { id }))
  }

  delete(id: string, opts?: { revision?: number }) {
    return call(this.#seat, 'delete', checked('delete', options(opts), { id }))
  }

  react(id: string, emoji: string, opts?: { remove?: boolean }) {
    return call(this.#seat, 'react', checked('react', { ...options(opts), emoji }, { id }))
  }

  /** Follows what a message is in (its thread, or its discussion on a doc), or unfollows it with { on: false }. */
  follow(id: string, opts?: { on?: boolean }) {
    return call(this.#seat, 'follow', checked('follow', options(opts), { id }))
  }

  /** What this caller follows, newest first. */
  follows(query?: { limit?: number }) {
    return call(this.#seat, 'follows', checked('follows', query))
  }

  label(id: string, change: { set?: Record<string, string>; unset?: string[]; if?: Record<string, string | null> }) {
    return call(this.#seat, 'label', checked('label', change, { id }))
  }

  /**
   * A page of the feed: events after a cursor, by the same filters as threads. wait (seconds, up to
   * 300) holds the call until something comes, woken by the board's Relay.
   */
  events(query?: Record<string, unknown>) {
    const input = checked('events', query) as { wait?: number }
    const wait = Math.min(Number(input.wait ?? 0), 300)
    return held<{ events: unknown[]; cursor: string }>(this.#seat, 'events', input, wait, (value) => value.events.length > 0, (value, asked) => {
      const { last: _last, ...rest } = asked
      return { ...rest, after: value.cursor }
    })
  }

  /** Posts later, once (in, at) or repeating (every, until, for, times): POST /schedules. */
  schedule(input: Record<string, unknown>) {
    return call(this.#seat, 'schedule', checked('schedule', input))
  }

  /** The pending schedules this caller can see: GET /schedules. */
  schedules(query?: { re?: string; channel?: string; by?: string; all?: boolean }) {
    return call(this.#seat, 'schedules', checked('schedules', query))
  }

  cancelSchedule(id: string) {
    return call(this.#seat, 'cancelSchedule', checked('cancelSchedule', undefined, { id }))
  }

  /** Tasks: threads with a state the board keeps. */
  get tasks(): Tasks {
    return new Tasks(this.#seat)
  }

  /** Docs: threads whose root holds a body, read and edited by section. */
  get docs(): Docs {
    return new Docs(this.#seat)
  }
}

/** The board's docs (ledger/docs.ts), each addressed by its root's ID or, with at(), its path. */
export class Docs extends RpcTarget {
  #seat: Seat
  constructor(seat: Seat) {
    super()
    this.#seat = seat
  }

  /** Makes a doc at channel/slug from its body, or from another doc as a template (from). */
  create(input: { channel: string; slug: string; body?: string; from?: string; labels?: Record<string, string>; id?: string }) {
    return call(this.#seat, 'createDoc', checked('createDoc', input))
  }

  /** A doc and its body; with section, that section only; with revision, as it was then. */
  read(id: string, query?: { section?: string; revision?: string; depth?: number }) {
    return call(this.#seat, 'doc', checked('doc', query, { id }))
  }

  /** The doc at a path (docs/runbooks/deploy), read as read() reads. */
  at(path: string, query?: { section?: string; revision?: string; depth?: number }) {
    return call(this.#seat, 'docAt', checked('docAt', { ...options(query), path }))
  }

  /**
   * Edits a doc: { revision, edits: [{ section, text }] } by section, checked per section, or
   * { revision | base, body, merge: true } as a whole. propose: true asks for it as a task instead.
   */
  edit(id: string, input: Record<string, unknown>) {
    return call(this.#seat, 'editDoc', checked('editDoc', input, { id }))
  }

  /** Moves a doc to a new channel, slug, or both: its ID, and every link to it, stay. */
  move(id: string, to: { channel?: string; slug?: string }) {
    return call(this.#seat, 'moveDoc', checked('moveDoc', to, { id }))
  }

  /** Its edits, oldest first: who, when, which sections. */
  history(id: string, query?: { after?: string; limit?: number }) {
    return call(this.#seat, 'docHistory', checked('docHistory', query, { id }))
  }

  /** The sections that changed between two revisions (to: now). */
  diff(id: string, from: string, to?: string) {
    return call(this.#seat, 'docDiff', checked('docDiff', { from, ...(to !== undefined ? { to } : {}) }, { id }))
  }

  /** The threads, replies, and docs that link it. */
  backlinks(id: string) {
    return call(this.#seat, 'docBacklinks', checked('docBacklinks', undefined, { id }))
  }
}

type Claimed = { task: unknown; claim: { epoch: number; token: string; until: string } }

export class Tasks extends RpcTarget {
  #seat: Seat
  constructor(seat: Seat) {
    super()
    this.#seat = seat
  }

  /** Tasks by state, channel, label, owner: GET /tasks. */
  list(query?: Record<string, unknown>) {
    return call(this.#seat, 'tasks', checked('tasks', query))
  }

  /** Starts a task in { channel, text }, or makes { re }'s thread one. claim: true answers its Claim too. */
  async create(input: Record<string, unknown>): Promise<{ task: unknown; claim?: Claim }> {
    const made = await call<{ task: unknown; claim?: Claimed['claim'] }>(this.#seat, 'createTask', checked('createTask', input))
    const id = (made.task as { id: string }).id
    return { task: made.task, ...(made.claim ? { claim: new Claim(this.#seat, id, { task: made.task, claim: made.claim }) } : {}) }
  }

  /** Several tasks in one channel, at once, needs between them by key: POST /tasks/batch. */
  createMany(channel: string, tasks: unknown[], opts?: { id?: string; request?: string }) {
    return call(this.#seat, 'createTasks', checked('createTasks', { ...options(opts), channel, tasks }))
  }

  /**
   * Claims task { id }, or the oldest ready one in { channel } ('work' or the subtree 'work/'), with
   * label and from. wait (seconds, up to 300) holds the call until one is ready: null when none was.
   */
  async claim(target: { id: string } | { channel: string; label?: Record<string, string>; from?: string[] }, opts?: { lease?: number; wait?: number; token?: string }): Promise<Claim | null> {
    if (!isPlain(target)) throw refuse(400, 'invalid_request', 'pass { id } or { channel }')
    const given = options(opts)
    if ('id' in target) {
      const { wait: _wait, ...rest } = given
      const id = target.id
      const made = await call<Claimed>(this.#seat, 'claimTask', checked('claimTask', rest, { id }))
      return new Claim(this.#seat, id, made)
    }
    const input = checked('claimReadyTask', { ...target, ...given }) as { wait?: number }
    const wait = Math.min(Number(input.wait ?? 0), 300)
    const made = await held<{ task: { id: string } | null; claim?: Claimed['claim'] }>(this.#seat, 'claimReadyTask', input, wait, (value) => value.task !== null, (_, asked) => asked)
    return made.task && made.claim ? new Claim(this.#seat, made.task.id, made as Claimed) : null
  }

  /** Holds a task for a person, without a claim (its owner, or a manager). */
  block(id: string, reason: string, kind?: string) {
    return call(this.#seat, 'blockTask', checked('blockTask', { reason, ...(kind !== undefined ? { kind } : {}) }, { id }))
  }

  unblock(id: string) {
    return call(this.#seat, 'unblockTask', checked('unblockTask', undefined, { id }))
  }

  reopen(id: string) {
    return call(this.#seat, 'reopenTask', checked('reopenTask', undefined, { id }))
  }

  cancel(id: string, reason: string) {
    return call(this.#seat, 'cancelTask', checked('cancelTask', { reason }, { id }))
  }

  /** Assigns it to an actor (null: anyone may claim it). */
  assign(id: string, to: string | null) {
    return call(this.#seat, 'assignTask', checked('assignTask', { for: to }, { id }))
  }

  /** Replaces what it waits for. */
  needs(id: string, needs: string[]) {
    return call(this.#seat, 'setTaskNeeds', checked('setTaskNeeds', { needs }, { id }))
  }
}

/**
 * A task you hold. Every method carries the claim's epoch and token, which stay on the server: the
 * token leaves only through sturdy(). Disposing the stub does nothing to the claim: it lasts until
 * its lease runs out, or until release, complete, or fail.
 */
export class Claim extends RpcTarget {
  #seat: Seat
  #id: string
  #epoch: number
  #token: string
  #until: string
  #task: unknown
  constructor(seat: Seat, id: string, claimed: Claimed) {
    super()
    this.#seat = seat
    this.#id = id
    this.#epoch = claimed.claim.epoch
    this.#token = claimed.claim.token
    this.#until = claimed.claim.until
    this.#task = claimed.task
  }
  get id(): string {
    return this.#id
  }
  /** The task as the last write on this claim left it. */
  get task(): unknown {
    return this.#task
  }
  get epoch(): number {
    return this.#epoch
  }
  get until(): string {
    return this.#until
  }
  #fenced(method: string, more: Record<string, unknown> = {}) {
    return checked(method, { ...more, epoch: this.#epoch, token: this.#token }, { id: this.#id })
  }
  async #write(method: string, more: Record<string, unknown> = {}) {
    const answer = await call<{ task: unknown; until?: string }>(this.#seat, method, this.#fenced(method, more))
    this.#task = answer.task
    if (answer.until) this.#until = answer.until
    return answer
  }
  /** Extends the lease from now, by lease seconds or the board's default: the new until. */
  async renew(lease?: number): Promise<string> {
    await this.#write('renewTask', lease !== undefined ? { lease } : {})
    return this.#until
  }
  release() {
    return this.#write('releaseTask')
  }
  complete(result?: string) {
    return this.#write('completeTask', result !== undefined ? { result } : {})
  }
  fail(reason: string) {
    return this.#write('failTask', { reason })
  }
  block(reason: string, kind?: string) {
    return this.#write('blockTask', { reason, ...(kind !== undefined ? { kind } : {}) })
  }
  /** The claim as data, for a process that outlives this session: what POST /tasks/:id/<verb> takes. */
  sturdy(): { id: string; epoch: number; token: string } {
    return { id: this.#id, epoch: this.#epoch, token: this.#token }
  }
  /** A dropped stub is not a release: the claim stays held until its lease ends. */
  [Symbol.dispose]() {}
}

/** A Board for a caller the Gateway verified: what /rpc and /mcp hand out. */
export function boardFor(env: BindingEnv, mount: Mount, caller: Caller, region: string): Board {
  return new Board({ env, name: mount.name, caller, mount, region })
}

const mountOf = (env: BindingEnv, name: string): Mount | undefined => {
  if (!env.BOARD_ORIGIN) return undefined
  const origin = env.BOARD_ORIGIN.replace(/\/+$/, '')
  return { name, origin, url: origin + '/b/' + name }
}

export type WorkbusProps = {
  /** The one board this binding reaches; any board when it's absent. */
  board?: string
  /** The Worker that holds the binding (its script name): it acts as worker:<principal>. */
  principal?: string
  /** What it may do, narrowed: x-board-can text ('deploys=read,post;work/=all') or a can object. */
  can?: string | Can
  /** The profile it writes as, as x-board-profile names one. */
  profile?: string
}

/**
 * The service binding another Worker in the account holds. Its props say who it is, so the binding
 * is the credential: only someone who can deploy to the account can set them.
 *
 *   "services": [{ "binding": "WORKBUS", "service": "workbus", "entrypoint": "Workbus",
 *                  "props": { "board": "acme", "principal": "deploys", "can": "deploys=read,post" } }]
 *
 *   const board = env.WORKBUS.board()          // or board('acme')
 *   await board.post('deploys', { text: sha + ' is live', id: 'deploy-' + sha })
 */
export class Workbus extends WorkerEntrypoint<BindingEnv, WorkbusProps> {
  board(name?: string): Board {
    const props = (this.ctx.props ?? {}) as WorkbusProps
    const wanted = (name ?? props.board ?? '').toLowerCase()
    if (!wanted) throw refuse(400, 'invalid_board', 'name the board: board(name), or props.board on the binding')
    if (!BOARD_NAME.test(wanted)) throw refuse(400, 'invalid_board', 'a board name is lowercase letters, digits, - and _, up to 64')
    if (props.board !== undefined && props.board.toLowerCase() !== wanted) throw refuse(403, 'forbidden', 'this binding reaches the board ' + props.board + ', not ' + wanted)
    const script = typeof props.principal === 'string' ? props.principal.replace(/^worker:/, '') : ''
    if (!SUB.test(script)) throw refuse(401, 'unauthorized', "this binding doesn't say which Worker holds it: set props.principal to its script name")
    const principal: Principal = { id: 'worker:' + script, kind: 'deployment', handle: script, name: script, facts: { issuer: 'binding', claims: { script } }, expiresAt: null }
    const caller: Caller = {
      principal,
      profile: props.profile !== undefined ? profileOf(props.profile) : null,
      narrow: props.can !== undefined ? canOf(props.can) : null,
      via: 'binding',
    }
    return new Board({ env: this.env, name: wanted, caller, mount: mountOf(this.env, wanted), region: 'xx' })
  }
}

// -- sessions: a verified caller's Board, sealed, for a Dynamic Worker -----------------------------

export type SessionProps = { caller: Caller; mount: Mount; region: string; exp: number; mac: string }
const SESSION_TTL_MS = 10 * 60 * 1000

const sessionKeys = new Map<string, Promise<CryptoKey>>()
function sessionKey(env: BindingEnv): Promise<CryptoKey> {
  let key = sessionKeys.get(env.BOARD_ISSUER_KEY)
  if (!key) {
    const secret = (JSON.parse(env.BOARD_ISSUER_KEY) as IssuerKey).d
    if (typeof secret !== 'string') throw new Error("BOARD_ISSUER_KEY has no private part to seal sessions with")
    key = crypto.subtle
      .digest('SHA-256', new TextEncoder().encode('workbus session\u0000' + secret))
      .then((raw) => crypto.subtle.importKey('raw', raw, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify']))
    sessionKeys.set(env.BOARD_ISSUER_KEY, key)
  }
  return key
}
const sealed = (props: Omit<SessionProps, 'mac'>) => new TextEncoder().encode(JSON.stringify([props.caller, props.mount, props.region, props.exp]))
const hex = (bytes: ArrayBuffer) => [...new Uint8Array(bytes)].map((byte) => byte.toString(16).padStart(2, '0')).join('')

/** Props for BoardSession that carry caller, sealed with the board's issuer key, good for ten minutes. */
export async function sessionProps(env: BindingEnv, mount: Mount, caller: Caller, region: string): Promise<SessionProps> {
  const props = { caller, mount, region, exp: Date.now() + SESSION_TTL_MS }
  return { ...props, mac: hex(await crypto.subtle.sign('HMAC', await sessionKey(env), sealed(props))) }
}

/**
 * A verified caller's Board, as an entrypoint a Dynamic Worker's env can hold (its env takes
 * entrypoints, not RPC stubs). Its props are sealed: a Worker that binds this entrypoint with props
 * of its own making gets nothing.
 */
export class BoardSession extends WorkerEntrypoint<BindingEnv, SessionProps> {
  async board(): Promise<Board> {
    const props = this.ctx.props as SessionProps | undefined
    if (!props || typeof props.mac !== 'string' || !/^[0-9a-f]{64}$/.test(props.mac)) throw refuse(401, 'unauthorized', 'this session is not sealed')
    const mac = new Uint8Array(props.mac.match(/../g)!.map((byte) => parseInt(byte, 16)))
    const ok = await crypto.subtle.verify('HMAC', await sessionKey(this.env), mac, sealed(props))
    if (!ok) throw refuse(401, 'unauthorized', 'this session is not sealed by this board')
    if (props.exp <= Date.now()) throw refuse(401, 'unauthorized', 'this session has expired')
    return boardFor(this.env, props.mount, props.caller, props.region)
  }
}

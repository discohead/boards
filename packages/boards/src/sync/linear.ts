// Linear, as a platform the board syncs: its webhooks checked against the webhook's signing secret
// and their timestamp, and each event as what it means on the board. An issue in a mapped team is
// a thread, its state and labels are labels on the root; its comments are replies.
import { hmacHex, sameString, secretReader, type Secret } from './secrets.ts'
import { ownEcho, SyncRefused, SyncRetry, trim, type ImportTools, type SyncProvider } from './provider.ts'

export type LinearOptions = {
  /** The webhook's signing secret: Linear signs every delivery with it. */
  webhookSecret: Secret
  /** The API key (lin_api_…) or OAuth token replies go back to Linear with. */
  apiKey?: Secret
  /** Each team (its key, like ENG, or its ID) and the board channel its issues come into. */
  teams: Record<string, string>
  /** The user the API key acts as: what Linear echoes of the board's copies waits for its receipt. */
  botUserId?: string
  /** Where Linear's GraphQL API is: https://api.linear.app/graphql unless a test says otherwise. */
  apiUrl?: string
}

export type LinearUser = { id: string; handle: string; name: string; avatar: string | null; isBot: boolean }

/** One thing a Linear webhook means, in the board's terms. */
export type LinearEvent =
  | { kind: 'root'; team: string; channel: string; thread: string; author: LinearUser; text: string; labels: Record<string, string> }
  | { kind: 'reply'; team: string; thread: string; subthread: string | null; message: string; author: LinearUser; text: string; own: boolean }
  | { kind: 'edit'; team: string; thread: string; message: string | null; author: LinearUser; text: string }
  | { kind: 'delete'; team: string; thread: string; message: string | null; author: LinearUser }
  /** The root's labels as Linear has them now: what's under label. and isn't here comes off. */
  | { kind: 'labels'; team: string; thread: string; author: LinearUser; labels: Record<string, string> }

export const LINEAR_REPLAY_WINDOW_MS = 60 * 1000

export type Verified = { ok: true; payload: any; body: string } | { ok: false; reason: 'stale' | 'signature' | 'body' }

/**
 * A delivery Linear signed with the secret, sent in the last minute: Linear-Signature is the hex
 * HMAC-SHA256 of the raw body, and the body's webhookTimestamp (ms) is when it was sent.
 */
export async function verifyLinear(request: Request, secret: string, now = Date.now()): Promise<Verified> {
  const body = await request.text()
  const signature = (request.headers.get('linear-signature') ?? '').toLowerCase()
  if (!sameString(signature, await hmacHex(secret, body))) return { ok: false, reason: 'signature' }
  let payload: any
  try {
    payload = JSON.parse(body)
  } catch {
    return { ok: false, reason: 'body' }
  }
  const sent = Number(payload?.webhookTimestamp)
  if (!Number.isFinite(sent) || Math.abs(now - sent) > LINEAR_REPLAY_WINDOW_MS) return { ok: false, reason: 'stale' }
  return { ok: true, payload, body }
}

export const linearThread = (issueId: string, key = 'linear') => key + ':issue:' + issueId

const userOf = (key: string, user: any, fallback?: any): LinearUser => {
  const who = user && typeof user === 'object' && user.id ? user : fallback && typeof fallback === 'object' && fallback.id ? fallback : null
  const id = String(who?.id ?? 'unknown')
  const name = String(who?.displayName || who?.name || id)
  return {
    id: key + ':user:' + id,
    handle: String(who?.displayName || (typeof who?.email === 'string' ? who.email.split('@')[0] : '') || name),
    name,
    avatar: typeof who?.avatarUrl === 'string' && who.avatarUrl.startsWith('https://') ? who.avatarUrl : null,
    isBot: who?.type !== undefined && who.type !== 'user',
  }
}

/** A Linear label's name as a board label key under label. */
export const labelKey = (name: string) =>
  'label.' + (name.normalize('NFKD').replace(/\p{M}/gu, '').toLowerCase().replace(/[^a-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 58) || 'unnamed')

/** An issue's labels on the board: its identifier, its state, and each of its labels. */
export function issueLabels(issue: any): Record<string, string> {
  const out: Record<string, string> = {}
  if (issue?.identifier) out.issue = String(issue.identifier).slice(0, 256)
  if (issue?.state?.name) out.state = String(issue.state.name).slice(0, 256)
  for (const label of Array.isArray(issue?.labels) ? issue.labels : []) if (label?.name) out[labelKey(String(label.name))] = String(label.name).slice(0, 256)
  return out
}

export const issueText = (issue: any) =>
  trim('**' + (issue.identifier ? issue.identifier + ': ' : '') + String(issue.title ?? '') + '**' + (issue.description ? '\n\n' + String(issue.description) : '') + (issue.url ? '\n\n' + issue.url : ''))

/** Which of its teams an issue is in: the options' entry for its key or ID. */
function teamOf(issue: any, options: LinearOptions): { team: string; channel: string | undefined } {
  const key: string | undefined = issue?.team?.key
  const id: string | undefined = issue?.team?.id ?? issue?.teamId
  const entry = Object.entries(options.teams).find(([name]) => (key !== undefined && name.toLowerCase() === key.toLowerCase()) || name === id)
  return { team: key ?? id ?? 'team', channel: entry?.[1] }
}

const changed = (from: any, ...fields: string[]) => from === undefined || from === null || fields.some((field) => Object.hasOwn(from, field))

/** What a Linear webhook means on the board: none, one, or a few platform events. */
export function linearEvents(payload: any, options: LinearOptions, key = 'linear'): LinearEvent[] {
  const data = payload?.data
  if (!data || typeof data !== 'object') return []
  const actor = payload.actor
  if (payload.type === 'Issue') {
    const { team, channel } = teamOf(data, options)
    const thread = linearThread(String(data.id), key)
    const author = userOf(key, actor, data.creator)
    if (payload.action === 'create') return channel ? [{ kind: 'root', team, channel, thread, author: userOf(key, data.creator, actor), text: issueText(data), labels: issueLabels(data) }] : []
    if (payload.action === 'update') {
      const out: LinearEvent[] = []
      if (changed(payload.updatedFrom, 'title', 'description', 'number', 'teamId')) out.push({ kind: 'edit', team, thread, message: null, author, text: issueText(data) })
      if (changed(payload.updatedFrom, 'stateId', 'labelIds', 'number', 'teamId')) out.push({ kind: 'labels', team, thread, author, labels: issueLabels(data) })
      return out
    }
    if (payload.action === 'remove') return [{ kind: 'delete', team, thread, message: null, author }]
    return []
  }
  if (payload.type === 'Comment') {
    const issueId = data.issueId ?? data.issue?.id
    if (!issueId) return []
    const { team } = teamOf(data.issue, options)
    const thread = linearThread(String(issueId), key)
    const message = 'comment-' + data.id
    const author = userOf(key, data.user, actor)
    if (payload.action === 'create') {
      const own = options.botUserId !== undefined && (data.userId ?? data.user?.id) === options.botUserId
      return [{ kind: 'reply', team, thread, subthread: data.parentId ? thread + ':comment-' + data.parentId : null, message, author, text: trim(String(data.body ?? '')), own }]
    }
    if (payload.action === 'update') return [{ kind: 'edit', team, thread, message, author, text: trim(String(data.body ?? '')) }]
    if (payload.action === 'remove') return [{ kind: 'delete', team, thread, message, author }]
    return []
  }
  return []
}

/** The inbox ID of a delivery's events: the same for Linear's retries of it, whenever they come. */
export const linearDelivery = (payload: any) =>
  [payload?.type, payload?.action, payload?.data?.id, payload?.data?.updatedAt ?? payload?.data?.archivedAt ?? payload?.data?.createdAt ?? payload?.webhookTimestamp].join(':')

const COMMENT_CREATE = 'mutation CommentCreate($input: CommentCreateInput!) { commentCreate(input: $input) { success comment { id } } }'
const COMMENT_UPDATE = 'mutation CommentUpdate($id: String!, $input: CommentUpdateInput!) { commentUpdate(id: $id, input: $input) { success } }'
const COMMENT_DELETE = 'mutation CommentDelete($id: String!) { commentDelete(id: $id) { success } }'
const REACTION_CREATE = 'mutation ReactionCreate($input: ReactionCreateInput!) { reactionCreate(input: $input) { success } }'

/** Linear as a sync provider: its webhooks in, comments out through GraphQL. */
export function linearProvider(options: LinearOptions): SyncProvider<LinearEvent> {
  const api = options.apiUrl ?? 'https://api.linear.app/graphql'
  const webhookSecret = secretReader(options.webhookSecret, 'the Linear webhook secret')
  const apiKey = options.apiKey === undefined ? null : secretReader(options.apiKey, 'the Linear API key')

  /** One GraphQL operation: its data; SyncRetry when Linear is busy; SyncRefused with Linear's words. */
  const graphql = async (query: string, variables: Record<string, unknown>): Promise<any> => {
    if (!apiKey) throw new SyncRefused('no Linear API key is configured')
    const key = await apiKey()
    // A personal API key goes as it is; an OAuth token as a bearer.
    const authorization = key.startsWith('lin_api_') || key.startsWith('Bearer ') ? key : 'Bearer ' + key
    const response = await fetch(api, { method: 'POST', headers: { authorization, 'content-type': 'application/json' }, body: JSON.stringify({ query, variables }) })
    if (response.status === 429 || response.status >= 500) throw new SyncRetry('Linear answered ' + response.status)
    const answer = (await response.json().catch(() => null)) as { data?: any; errors?: { message?: string; extensions?: { code?: string } }[] } | null
    if (answer?.errors?.some((error) => error.extensions?.code === 'RATELIMITED')) throw new SyncRetry('Linear answered RATELIMITED')
    if (!response.ok || !answer || answer.errors?.length) throw new SyncRefused('Linear answered ' + response.status + ': ' + (answer?.errors?.map((error) => error.message).join('; ') || 'no data'))
    return answer.data
  }
  const commentId = (copy: { message: string }) => copy.message.match(/^comment-(.+)$/)?.[1] ?? null

  const external = (key: string, event: LinearEvent) => {
    const at = { channel: key + ':' + event.team, thread: event.thread, subthread: event.kind === 'reply' ? event.subthread : null }
    switch (event.kind) {
      case 'root':
        return { kind: 'lifecycle', channel: at.channel, thread: at.thread, type: 'issue', title: event.text.split('\n')[0]!, url: null, body: event.text, labels: event.labels, unset: [], reply: null, createRoot: true, author: event.author }
      case 'reply':
        return { kind: 'message', ...at, message: event.message, isRoot: false, text: event.text, context: null, author: event.author }
      case 'edit':
        return { kind: 'edited', ...at, message: event.message ?? 'issue', text: event.text, author: event.author }
      case 'delete':
        return { kind: 'deleted', ...at, message: event.message ?? 'issue' }
      case 'labels':
        return { kind: 'lifecycle', channel: at.channel, thread: at.thread, type: 'state', title: '', url: null, labels: event.labels, unset: [], reply: null, createRoot: false, author: event.author }
    }
  }

  return {
    platform: 'linear',
    async receive(request, { key }) {
      const verified = await verifyLinear(request, await webhookSecret())
      if (!verified.ok) return { events: [], response: new Response(verified.reason === 'stale' ? 'too old, or no webhookTimestamp\n' : 'not signed by this webhook\n', { status: 401 }) }
      const id = linearDelivery(verified.payload)
      const events = linearEvents(verified.payload, options, key).map((event, n) => ({ id: id + ':' + n, thread: event.thread, channel: key + ':' + event.team, event, raw: { ...verified.payload, view: external(key, event) } }))
      return { events }
    },

    async import(event, tools: ImportTools) {
      const { key, call, rootOf } = tools
      const from = key
      const channel = key + ':' + event.team
      switch (event.kind) {
        case 'root':
          return call('syncImport', { op: 'post', from, author: event.author, origin: { channel, thread: event.thread, subthread: null, message: 'issue', context: null }, channel: event.channel, text: event.text, labels: event.labels, id: event.thread + ':issue' })
        case 'reply': {
          if (event.own && (await ownEcho(tools, event.thread, event.message))) return { message: null }
          const re = await rootOf(event.thread)
          if (!re) return { message: null }
          return call('syncImport', { op: 'post', from, author: event.author, origin: { channel, thread: event.thread, subthread: event.subthread, message: event.message, context: null }, re, text: event.text || '(empty)', id: event.thread + ':' + event.message })
        }
        case 'edit': {
          if (event.message === null) {
            // An issue's update says what changed, not what it was: an unchanged root takes no edit.
            const root = await rootOf(event.thread)
            if (!root) return { message: null }
            const view = await call('message', { id: root, limit: 1 })
            if (view.message.text === event.text) return { message: root }
          }
          return call('syncImport', { op: 'edit', from, author: event.author, origin: { thread: event.thread, ...(event.message ? { message: event.message } : {}) }, text: event.text.trim() || '(empty)' })
        }
        case 'delete':
          return call('syncImport', { op: 'delete', from, author: event.author, origin: { thread: event.thread, ...(event.message ? { message: event.message } : {}) } })
        case 'labels': {
          const root = await rootOf(event.thread)
          if (!root) return { message: null }
          const view = await call('message', { id: root, limit: 1 })
          const now: Record<string, string> = view.message.labels ?? {}
          const set: Record<string, string> = {}
          for (const [label, value] of Object.entries(event.labels)) if (now[label] !== value) set[label] = value
          const unset = Object.keys(now).filter((label) => label.startsWith('label.') && !Object.hasOwn(event.labels, label))
          if (!Object.keys(set).length && !unset.length) return { message: root }
          return call('syncImport', { op: 'labels', from, author: event.author, origin: { thread: event.thread }, set, unset })
        }
      }
    },

    async post({ target, thread, message }, { key }) {
      const issueId = (thread ?? target).match(new RegExp('^' + key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + ':issue:([^:]+)$'))?.[1]
      // A board thread synced to a team would be a new issue: Linear's threads start in Linear here.
      if (!issueId) throw new SyncRefused((thread ?? target) + " isn't a Linear issue: a thread syncs to Linear from an issue")
      const data = await graphql(COMMENT_CREATE, { input: { issueId, body: message.text } })
      if (!data?.commentCreate?.success || !data.commentCreate.comment?.id) throw new SyncRetry('Linear didn' + "'" + 't create the comment')
      return { thread: key + ':issue:' + issueId, message: 'comment-' + data.commentCreate.comment.id }
    },
    async edit({ copy, message }) {
      const id = commentId(copy)
      if (id) await graphql(COMMENT_UPDATE, { id, input: { body: message.text } })
    },
    async delete({ copy }) {
      const id = commentId(copy)
      if (id) await graphql(COMMENT_DELETE, { id })
    },
    async react({ copy, emoji, remove }) {
      const id = commentId(copy)
      // Removing one takes its ID: removals stay on the board.
      if (id && !remove) await graphql(REACTION_CREATE, { input: { commentId: id, emoji } })
    },
  }
}
// Slack, as a platform the board syncs: its Events API requests checked against the app's signing
// secret, and each event as what it means on the board. A message in a mapped channel is a thread;
// its thread replies are replies; edits, deletes, and reactions change what came in.
import { hmacHex, sameString, secretReader, type Secret } from './secrets.ts'
import { ownEcho, SyncRefused, SyncRetry, trim, type ImportTools, type SyncProvider, type SyncUser } from './provider.ts'

export type SlackOptions = {
  /** The app's signing secret: Slack signs every request with it. */
  signingSecret: Secret
  /** The bot token (xoxb-…) replies go back to Slack with, and people's names are read with. */
  botToken?: Secret
  /** Each Slack channel ID and the board channel its threads come into. */
  channels: Record<string, string>
  /** The bot's own user ID (and bot ID): what Slack echoes of the board's copies waits for its receipt. */
  botUserId?: string
  botId?: string
  /** Where Slack's Web API is: https://slack.com/api unless a test says otherwise. */
  apiBase?: string
}

/** Who wrote a Slack event, as the event says it; names are read when it's imported. */
export type SlackAuthor = { user: string | null; bot: string | null; name: string | null; avatar: string | null }

/** One thing a Slack event means, in the board's terms. */
export type SlackEvent =
  | { kind: 'root'; slackChannel: string; channel: string; thread: string; ts: string; author: SlackAuthor; text: string; mentioned: string[]; own: boolean }
  | { kind: 'reply'; slackChannel: string; thread: string; ts: string; author: SlackAuthor; text: string; mentioned: string[]; own: boolean }
  | { kind: 'edit'; slackChannel: string; thread: string; ts: string; author: SlackAuthor; text: string; mentioned: string[] }
  | { kind: 'delete'; slackChannel: string; thread: string; ts: string; author: SlackAuthor }
  | { kind: 'react'; slackChannel: string; ts: string; author: SlackAuthor; emoji: string; remove: boolean }

export const SLACK_REPLAY_WINDOW_S = 5 * 60

export type Verified = { ok: true; payload: any; body: string } | { ok: false; reason: 'stale' | 'signature' | 'body' }

/**
 * A request Slack signed with the secret, at most 5 minutes old: v0=HMAC-SHA256(secret,
 * "v0:" + X-Slack-Request-Timestamp + ":" + body), in X-Slack-Signature.
 */
export async function verifySlack(request: Request, secret: string, now = Date.now()): Promise<Verified> {
  const body = await request.text()
  const stamp = request.headers.get('x-slack-request-timestamp') ?? ''
  const signature = request.headers.get('x-slack-signature') ?? ''
  if (!/^\d{1,12}$/.test(stamp) || Math.abs(Math.floor(now / 1000) - Number(stamp)) > SLACK_REPLAY_WINDOW_S) return { ok: false, reason: 'stale' }
  const expected = 'v0=' + (await hmacHex(secret, 'v0:' + stamp + ':' + body))
  if (!sameString(signature, expected)) return { ok: false, reason: 'signature' }
  // Slash commands and interactivity come form-encoded; the Events API is JSON.
  try {
    return { ok: true, payload: JSON.parse(body), body }
  } catch {
    return { ok: false, reason: 'body' }
  }
}

const entities = (text: string) => text.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&')

/** Slack's mrkdwn as the board's markdown: links, people, channels, and its three entities. */
export function fromSlack(text: string, key = 'slack'): { text: string; mentioned: string[] } {
  const mentioned: string[] = []
  const out = text.replace(/<([^<>\s][^<>]*)>/g, (whole, inner: string) => {
    const [target, label] = inner.split('|', 2) as [string, string | undefined]
    if (target.startsWith('@')) {
      const id = target.slice(1)
      if (!/^[UW][A-Z0-9]+$/.test(id)) return whole
      if (!mentioned.includes(id)) mentioned.push(id)
      return '@[' + key + ':user:' + id + ']'
    }
    if (target.startsWith('#')) return '#' + (label ?? target.slice(1))
    if (target.startsWith('!subteam^')) return label ?? '@team'
    if (target.startsWith('!date^')) return label ?? ''
    if (target.startsWith('!')) return '@' + target.slice(1)
    const url = entities(target)
    if (label === undefined) return url
    return '[' + label + '](' + url + ')'
  })
  return { text: entities(out), mentioned }
}

/** The board's text as Slack's: its three characters escaped, Slack users it mentions as Slack's mentions. */
export function toSlack(text: string, key = 'slack'): string {
  const mention = new RegExp('@\\[(?:[^\\]\\s+]*\\+)?' + key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + ':user:([UW][A-Z0-9]+)\\]', 'g')
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(mention, '<@$1>')
}

/** A reaction's name as a board emoji: Slack's name, without a skin tone. */
export const slackEmoji = (name: string) => name.split('::')[0]!.toLowerCase().replace(/[^a-z0-9_+-]/g, '_').slice(0, 64)

const threadOf = (key: string, channel: string, ts: string) => key + ':' + channel + ':' + ts

const authorOf = (event: any): SlackAuthor => ({
  user: typeof event?.user === 'string' ? event.user : null,
  bot: typeof event?.bot_id === 'string' ? event.bot_id : null,
  name: event?.user_profile?.real_name || event?.user_profile?.display_name || event?.username || null,
  avatar: typeof event?.user_profile?.image_72 === 'string' ? event.user_profile.image_72 : null,
})

/** Message subtypes that are someone saying something; the rest (joins, topics, pins) aren't. */
const SAYS = new Set([undefined, 'thread_broadcast', 'file_share', 'bot_message', 'me_message'])

/** What a Slack Events API request means on the board: none, or one platform event. */
export function slackEvents(payload: any, options: SlackOptions, key = 'slack'): SlackEvent[] {
  if (payload?.type !== 'event_callback') return []
  const event = payload.event
  if (!event || typeof event !== 'object') return []
  const own = (author: any) => (options.botUserId !== undefined && author?.user === options.botUserId) || (options.botId !== undefined && author?.bot_id === options.botId)
  if (event.type === 'message') {
    const slackChannel: string = event.channel
    const channel = options.channels[slackChannel]
    if (!channel) return []
    if (SAYS.has(event.subtype)) {
      const ts: string = event.ts
      const { text, mentioned } = fromSlack(String(event.text ?? ''), key)
      if (!text.trim()) return []
      const author = authorOf(event)
      if (!event.thread_ts || event.thread_ts === ts) return [{ kind: 'root', slackChannel, channel, thread: threadOf(key, slackChannel, ts), ts, author, text: trim(text), mentioned, own: own(event) }]
      return [{ kind: 'reply', slackChannel, thread: threadOf(key, slackChannel, event.thread_ts), ts, author, text: trim(text), mentioned, own: own(event) }]
    }
    if (event.subtype === 'message_changed') {
      const message = event.message ?? {}
      const before = event.previous_message ?? {}
      const thread = threadOf(key, slackChannel, message.thread_ts && message.thread_ts !== message.ts ? message.thread_ts : message.ts)
      // A root deleted under its replies stays as a tombstone.
      if (message.subtype === 'tombstone') return [{ kind: 'delete', slackChannel, thread, ts: message.ts, author: authorOf(before) }]
      // A reply count, an unfurl, a reaction: the message changed, its text didn't.
      if (message.text === before.text) return []
      const { text, mentioned } = fromSlack(String(message.text ?? ''), key)
      if (!text.trim()) return []
      return [{ kind: 'edit', slackChannel, thread, ts: message.ts, author: authorOf(message), text: trim(text), mentioned }]
    }
    if (event.subtype === 'message_deleted') {
      const before = event.previous_message ?? {}
      const ts: string = event.deleted_ts ?? before.ts
      const thread = threadOf(key, slackChannel, before.thread_ts && before.thread_ts !== ts ? before.thread_ts : ts)
      return [{ kind: 'delete', slackChannel, thread, ts, author: authorOf(before) }]
    }
    return []
  }
  if ((event.type === 'reaction_added' || event.type === 'reaction_removed') && event.item?.type === 'message') {
    const slackChannel: string = event.item.channel
    if (!options.channels[slackChannel]) return []
    const emoji = slackEmoji(String(event.reaction ?? ''))
    if (!emoji) return []
    return [{ kind: 'react', slackChannel, ts: event.item.ts, author: authorOf(event), emoji, remove: event.type === 'reaction_removed' }]
  }
  return []
}

/** Where a Slack event lands in the inbox: its lane is its thread; a reaction's is its message's own. */
export function slackLocation(event: SlackEvent, key = 'slack'): { channel: string; thread: string } {
  return { channel: key + ':' + event.slackChannel, thread: event.kind === 'react' ? threadOf(key, event.slackChannel, event.ts) : event.thread }
}

const SLACK_USER_TTL_MS = 10 * 60 * 1000
/** The board's canonical emoji names, as Slack names them. */
const SLACK_NAMES: Record<string, string> = { thumbs_up: '+1', thumbs_down: '-1', check: 'white_check_mark', party: 'tada', laugh: 'laughing', smile: 'slightly_smiling_face', sad: 'white_frowning_face', cry: 'sob', lightning: 'zap', lightbulb: 'bulb', pin: 'pushpin', love: 'heart_eyes' }

/** Slack as a sync provider: Events API requests in, chat.postMessage (and the rest) out as the bot. */
export function slackProvider(options: SlackOptions): SyncProvider<SlackEvent> {
  const api = (options.apiBase ?? 'https://slack.com/api').replace(/\/+$/, '')
  const signingSecret = secretReader(options.signingSecret, 'the Slack signing secret')
  const botToken = options.botToken === undefined ? null : secretReader(options.botToken, 'the Slack bot token')

  /** One Web API method: its answer when ok; SyncRetry when Slack is busy; SyncRefused with Slack's words. */
  const slack = async (method: string, body: Record<string, unknown>, read = false): Promise<any> => {
    if (!botToken) throw new SyncRefused('no Slack bot token is configured')
    const headers = { authorization: 'Bearer ' + (await botToken()), 'content-type': 'application/json; charset=utf-8' }
    const response = read
      ? await fetch(api + '/' + method + '?' + new URLSearchParams(body as Record<string, string>), { headers })
      : await fetch(api + '/' + method, { method: 'POST', headers, body: JSON.stringify(body) })
    if (response.status === 429 || response.status >= 500) throw new SyncRetry('Slack answered ' + response.status + ' to ' + method)
    const answer = (await response.json().catch(() => null)) as { ok?: boolean; error?: string } | null
    if (!answer?.ok) {
      if (answer?.error === 'ratelimited' || answer?.error === 'internal_error' || answer?.error === 'service_unavailable') throw new SyncRetry('Slack answered ' + answer.error + ' to ' + method)
      throw new SyncRefused('Slack answered ' + response.status + ' ' + (answer?.error ?? 'without ok') + ' to ' + method)
    }
    return answer
  }

  // People's names, read once per user for a while; without a token, their IDs.
  const users = new Map<string, { at: number; user: Promise<SyncUser> }>()
  const userOf = (key: string, author: SlackAuthor): Promise<SyncUser> => {
    if (!author.user) {
      const bot = author.bot ?? 'unknown'
      return Promise.resolve({ id: key + ':bot:' + bot, handle: author.name ?? bot, name: author.name ?? bot, avatar: author.avatar, isBot: true })
    }
    const id = author.user
    const known = users.get(key + ':' + id)
    if (known && Date.now() - known.at < SLACK_USER_TTL_MS) return known.user
    const plain: SyncUser = { id: key + ':user:' + id, handle: id, name: author.name ?? id, avatar: author.avatar, isBot: author.bot !== null }
    const user = botToken
      ? slack('users.info', { user: id }, true).then(
          ({ user }) => ({
            id: plain.id,
            handle: String(user?.name || id),
            name: String(user?.profile?.display_name || user?.real_name || user?.name || plain.name),
            avatar: typeof user?.profile?.image_72 === 'string' && user.profile.image_72.startsWith('https://') ? user.profile.image_72 : plain.avatar,
            isBot: Boolean(user?.is_bot) || plain.isBot,
          }),
          () => plain,
        )
      : Promise.resolve(plain)
    users.set(key + ':' + id, { at: Date.now(), user })
    return user
  }
  const mentionedOf = (key: string, ids: string[]) => Promise.all(ids.map((id) => userOf(key, { user: id, bot: null, name: null, avatar: null })))

  /** The Slack thread a message is in, when the message isn't a thread's root. */
  const threadTs = async (channel: string, ts: string): Promise<string | null> => {
    if (!botToken) return null
    const answer = await slack('conversations.replies', { channel, ts, limit: '1' }, true).catch(() => null)
    const found = answer?.messages?.find((message: { ts?: string }) => message.ts === ts) ?? answer?.messages?.[0]
    const thread = found?.thread_ts
    return typeof thread === 'string' && thread !== ts ? thread : null
  }

  /** A target or copy's Slack channel and thread. */
  const where = (key: string, at: string) => {
    const found = at.slice(key.length + 1).match(/^([A-Z0-9]+)(?::(\d+\.\d+))?$/)
    if (!found) throw new SyncRefused(at + " isn't a Slack channel or thread")
    return { channel: found[1]!, ts: found[2] ?? null }
  }

  const external = (key: string, event: SlackEvent) => {
    const at = { ...slackLocation(event, key), subthread: null }
    const author = { id: event.author.user ? key + ':user:' + event.author.user : key + ':bot:' + (event.author.bot ?? 'unknown'), handle: event.author.user ?? event.author.bot ?? 'unknown', name: event.author.name ?? event.author.user ?? 'unknown', avatar: null, isBot: !event.author.user }
    switch (event.kind) {
      case 'root':
      case 'reply':
        return { kind: 'message', ...at, message: event.ts, isRoot: event.kind === 'root', text: event.text, context: null, author }
      case 'edit':
        return { kind: 'edited', ...at, message: event.ts, text: event.text, author }
      case 'delete':
        return { kind: 'deleted', ...at, message: event.ts }
      case 'react':
        return { kind: 'reaction', ...at, message: event.ts, emoji: event.emoji, added: !event.remove, author }
    }
  }

  return {
    platform: 'slack',
    async receive(request, { key }) {
      const verified = await verifySlack(request, await signingSecret())
      if (!verified.ok) return { events: [], response: new Response(verified.reason === 'stale' ? 'too old, or no timestamp\n' : 'not signed by this app\n', { status: 401 }) }
      const payload = verified.payload
      if (payload?.type === 'url_verification') return { events: [], response: new Response(String(payload.challenge ?? ''), { headers: { 'content-type': 'text/plain' } }) }
      const id = String(payload.event_id || crypto.randomUUID())
      const events = slackEvents(payload, options, key).map((event, n) => ({ id: id + ':' + n, ...slackLocation(event, key), event, raw: { ...payload, view: external(key, event) } }))
      return { events }
    },

    async import(event, tools: ImportTools) {
      const { key, call, rootOf } = tools
      const from = key
      const channel = key + ':' + event.slackChannel
      switch (event.kind) {
        case 'root':
        case 'reply': {
          // What the courier posted here comes back as Slack's echo: it waits for its receipt, then lands as nothing.
          if (event.own && (await ownEcho(tools, event.thread, event.ts))) return { message: null }
          const author = await userOf(key, event.author)
          const mentioned = await mentionedOf(key, event.mentioned)
          const origin = { channel, thread: event.thread, subthread: null, message: event.ts, context: null }
          if (event.kind === 'root') return call('syncImport', { op: 'post', from, author, origin, channel: event.channel, text: event.text, labels: {}, mentioned, id: event.thread + ':' + event.ts })
          const re = await rootOf(event.thread)
          if (!re) return { message: null }
          return call('syncImport', { op: 'post', from, author, origin, re, text: event.text, mentioned, id: event.thread + ':' + event.ts })
        }
        case 'edit':
          return call('syncImport', { op: 'edit', from, author: await userOf(key, event.author), origin: { thread: event.thread, message: event.ts }, text: event.text, mentioned: await mentionedOf(key, event.mentioned) })
        case 'delete':
          return call('syncImport', { op: 'delete', from, author: await userOf(key, event.author), origin: { thread: event.thread, message: event.ts } })
        case 'react': {
          const author = await userOf(key, event.author)
          const react = (thread: string) => call('syncImport', { op: 'react', from, author, origin: { thread, message: event.ts }, emoji: event.emoji, remove: event.remove })
          // A reaction names its message, not its thread: a root is its own; a reply's, Slack says.
          const asRoot = await react(key + ':' + event.slackChannel + ':' + event.ts)
          if (asRoot.message) return asRoot
          const thread = await threadTs(event.slackChannel, event.ts)
          return thread ? react(key + ':' + event.slackChannel + ':' + thread) : asRoot
        }
      }
    },

    async post({ target, thread, message }, { key }) {
      const at = where(key, thread ?? target)
      const posted = await slack('chat.postMessage', { channel: at.channel, ...(at.ts ? { thread_ts: at.ts } : {}), text: toSlack(message.text, key) })
      return { thread: key + ':' + at.channel + ':' + (at.ts ?? posted.ts), message: String(posted.ts) }
    },
    async edit({ copy, message }, { key }) {
      await slack('chat.update', { channel: where(key, copy.thread).channel, ts: copy.message, text: toSlack(message.text, key) })
    },
    async delete({ copy }, { key }) {
      await slack('chat.delete', { channel: where(key, copy.thread).channel, ts: copy.message })
    },
    async react({ copy, emoji, remove }, { key }) {
      await slack(remove ? 'reactions.remove' : 'reactions.add', { channel: where(key, copy.thread).channel, timestamp: copy.message, name: SLACK_NAMES[emoji] ?? emoji })
    },
    async startTyping({ thread, status }, { key }) {
      const at = where(key, thread)
      if (at.ts) await slack('assistant.threads.setStatus', { channel_id: at.channel, thread_ts: at.ts, status: status ?? 'is typing…' })
    },
  }
}
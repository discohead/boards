// GitHub, as a platform the board syncs: its webhooks checked against the app's secret, and each
// event as what it means on the board. An issue or a pull request is a thread; its comments and
// reviews are replies; its state is labels on the root. What's written on the board in its threads
// goes back as comments, as the app (the token it's given).
import { ownEcho, SyncRefused, SyncRetry, type InboxEvent, type SyncProvider } from './provider.ts'
import { isSecret, readSecret, secretReader, type Secret } from './secrets.ts'
import { importDocFile } from './docfiles.ts'

export type GitHubOptions = {
  /** The webhook secret GitHub signs deliveries with: a Worker secret, or a Secrets Store binding. */
  webhookSecret: Secret
  /** Each repo (owner/name) and the board channel its issues and pull requests come into. */
  repos: Record<string, string>
  /** Whether an event may start a thread: a fork's pull request or the app's own shouldn't. */
  starts?: (event: PlatformEvent) => boolean
  /** The token comments go back with: one per repo (an app's installation token), or one for all (a Worker secret or Secrets Store). */
  token?: ((repo: string) => Promise<string>) | Secret
  /** The app's bot user ID: its comments wait for the courier's receipt before they're imported. */
  botUserId?: string
  /** Where GitHub's REST API is: https://api.github.com unless a test says otherwise. */
  apiBase?: string
  /**
   * Markdown docs kept in step with board docs (ledger/docs.ts), per repo: the files under dir
   * (docs/runbooks/deploy.md) are the docs under channel (docs/runbooks/deploy), both ways. A push to
   * branch (the repo's default) imports each changed file as a merge against what it was before; a
   * doc written on the board is committed as the app.
   */
  docs?: Record<string, { dir: string; channel: string; branch?: string }>
}

export type Author = { id: string; handle: string; name: string; avatar: string | null; isBot: boolean }

/** One thing a GitHub delivery means, in the board's terms. */
export type PlatformEvent =
  | { kind: 'root'; key: string; channel: string; thread: string; message: string; repo: string; number: number; author: Author; text: string; labels: Record<string, string>; pr: boolean; raw: unknown }
  | { kind: 'reply'; key: string; thread: string; subthread: string | null; message: string; author: Author; text: string; labels?: Record<string, string>; raw: unknown }
  | { kind: 'edit'; key: string; thread: string; message: string | null; author: Author; text: string; raw: unknown }
  | { kind: 'delete'; key: string; thread: string; message: string; author: Author; raw: unknown }
  | { kind: 'labels'; key: string; thread: string; author: Author; set: Record<string, string>; unset: string[]; raw: unknown }
  | { kind: 'docfile'; key: string; thread: string; repo: string; path: string; before: string; after: string; removed: boolean; author: Author; raw: unknown }

const hex = (bytes: ArrayBuffer) => [...new Uint8Array(bytes)].map((byte) => byte.toString(16).padStart(2, '0')).join('')

/** The delivery, when GitHub signed it with the secret; null when it didn't. */
export async function verifyGitHub(request: Request, secret: string): Promise<{ event: string; delivery: string; payload: any; body: string } | null> {
  const body = await request.text()
  const signature = request.headers.get('x-hub-signature-256') ?? ''
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'])
  const expected = 'sha256=' + hex(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(body)))
  if (signature.length !== expected.length) return null
  let diff = 0
  for (let i = 0; i < expected.length; i++) diff |= signature.charCodeAt(i) ^ expected.charCodeAt(i)
  if (diff !== 0) return null
  let payload: unknown
  try {
    payload = JSON.parse(body)
  } catch {
    return null
  }
  return { event: request.headers.get('x-github-event') ?? '', delivery: request.headers.get('x-github-delivery') ?? '', payload, body }
}

const authorOf = (key: string, user: any): Author => ({
  id: key + ':user:' + String(user?.id ?? 'unknown'),
  handle: String(user?.login ?? 'unknown'),
  name: String(user?.login ?? 'unknown'),
  avatar: typeof user?.avatar_url === 'string' && user.avatar_url.startsWith('https://') ? user.avatar_url : null,
  isBot: user?.type === 'Bot',
})

const trim = (text: string, max = 9000) => (text.length <= max ? text : text.slice(0, max) + '\n\n…')

/** What a GitHub delivery means on the board: none, one, or a few platform events. */
export function githubEvents(key: string, delivery: { event: string; payload: any }, options: GitHubOptions): PlatformEvent[] {
  const { event, payload } = delivery
  const repo: string | undefined = payload?.repository?.full_name
  if (!repo) return []
  const mapped = Object.entries(options.repos).find(([name]) => name.toLowerCase() === repo.toLowerCase())
  const channel = mapped?.[1]
  const sender = authorOf(key, payload.sender)
  const threadOf = (number: number) => key + ':' + repo + ':' + number
  const out: PlatformEvent[] = []
  if (event === 'push') {
    const docs = docsOf(options, repo)
    if (!docs) return out
    const branch = docs.branch ?? payload.repository?.default_branch ?? 'main'
    if (payload.ref !== 'refs/heads/' + branch) return out
    // The courier's own commits: the board has them already.
    if (options.botUserId !== undefined && String(payload.sender?.id) === options.botUserId) return out
    const files = new Map<string, boolean>()
    for (const commit of payload.commits ?? []) {
      for (const path of [...(commit.added ?? []), ...(commit.modified ?? [])]) files.set(path, false)
      for (const path of commit.removed ?? []) files.set(path, true)
    }
    for (const [path, removed] of files)
      if (path.startsWith(docs.dir + '/') && path.endsWith('.md')) out.push({ kind: 'docfile', key, thread: key + ':' + repo + ':file:' + path, repo, path, before: String(payload.before), after: String(payload.after), removed, author: sender, raw: payload })
    return out
  }
  const start = (root: Extract<PlatformEvent, { kind: 'root' }>) => {
    if (!channel) return
    if (options.starts && !options.starts(root)) return
    out.push(root)
  }
  if (event === 'issues') {
    const issue = payload.issue
    const thread = threadOf(issue.number)
    const text = '**Issue #' + issue.number + ': ' + issue.title + '**\n\n' + trim(issue.body ?? '')
    if (payload.action === 'opened')
      start({ kind: 'root', key, channel: channel!, thread, message: 'issue', repo, number: issue.number, author: authorOf(key, issue.user), text, labels: { issue: repo + '#' + issue.number, state: 'open' }, pr: false, raw: payload })
    else if (payload.action === 'edited') out.push({ kind: 'edit', key, thread, message: null, author: authorOf(key, issue.user), text, raw: payload })
    else if (payload.action === 'closed') out.push({ kind: 'labels', key, thread, author: sender, set: { state: issue.state_reason === 'not_planned' ? 'not-planned' : 'closed' }, unset: [], raw: payload })
    else if (payload.action === 'reopened') out.push({ kind: 'labels', key, thread, author: sender, set: { state: 'open' }, unset: [], raw: payload })
    return out
  }
  if (event === 'pull_request') {
    const pr = payload.pull_request
    const thread = threadOf(pr.number)
    const text = '**Pull request #' + pr.number + ': ' + pr.title + '**\n\n' + trim(pr.body ?? '') + '\n\n' + pr.html_url
    if (payload.action === 'opened')
      start({ kind: 'root', key, channel: channel!, thread, message: 'pr', repo, number: pr.number, author: authorOf(key, pr.user), text, labels: { pr: repo + '#' + pr.number, state: pr.draft ? 'draft' : 'open' }, pr: true, raw: payload })
    else if (payload.action === 'edited') out.push({ kind: 'edit', key, thread, message: null, author: authorOf(key, pr.user), text, raw: payload })
    else if (payload.action === 'closed') out.push({ kind: 'labels', key, thread, author: sender, set: { state: pr.merged ? 'merged' : 'closed' }, unset: [], raw: payload })
    else if (payload.action === 'reopened' || payload.action === 'ready_for_review') out.push({ kind: 'labels', key, thread, author: sender, set: { state: 'open' }, unset: [], raw: payload })
    else if (payload.action === 'converted_to_draft') out.push({ kind: 'labels', key, thread, author: sender, set: { state: 'draft' }, unset: [], raw: payload })
    return out
  }
  if (event === 'issue_comment') {
    const thread = threadOf(payload.issue.number)
    const comment = payload.comment
    const message = 'comment-' + comment.id
    if (payload.action === 'created') out.push({ kind: 'reply', key, thread, subthread: null, message, author: authorOf(key, comment.user), text: trim(comment.body ?? ''), raw: payload })
    else if (payload.action === 'edited') out.push({ kind: 'edit', key, thread, message, author: authorOf(key, comment.user), text: trim(comment.body ?? ''), raw: payload })
    else if (payload.action === 'deleted') out.push({ kind: 'delete', key, thread, message, author: authorOf(key, comment.user), raw: payload })
    return out
  }
  if (event === 'pull_request_review' && payload.action === 'submitted') {
    const review = payload.review
    const thread = threadOf(payload.pull_request.number)
    const state = String(review.state ?? '').toLowerCase()
    const verdict = state === 'approved' ? 'approved' : state === 'changes_requested' ? 'changes requested' : 'commented'
    if (state === 'commented' && !review.body) return out
    out.push({ kind: 'reply', key, thread, subthread: null, message: 'review-' + review.id, author: authorOf(key, review.user), text: '**Review: ' + verdict + '**' + (review.body ? '\n\n' + trim(review.body) : ''), raw: payload })
    if (state === 'approved' || state === 'changes_requested') out.push({ kind: 'labels', key, thread, author: authorOf(key, review.user), set: { review: state === 'approved' ? 'approved' : 'changes-requested' }, unset: [], raw: payload })
    return out
  }
  if (event === 'pull_request_review_comment') {
    const thread = threadOf(payload.pull_request.number)
    const comment = payload.comment
    const message = 'rc-' + comment.id
    const where = comment.path ? '\u0060' + comment.path + (comment.line ? ':' + comment.line : '') + '\u0060\n\n' : ''
    if (payload.action === 'created') out.push({ kind: 'reply', key, thread, subthread: thread + ':rc:' + (comment.in_reply_to_id ?? comment.id), message, author: authorOf(key, comment.user), text: where + trim(comment.body ?? ''), raw: payload })
    else if (payload.action === 'edited') out.push({ kind: 'edit', key, thread, message, author: authorOf(key, comment.user), text: where + trim(comment.body ?? ''), raw: payload })
    else if (payload.action === 'deleted') out.push({ kind: 'delete', key, thread, message, author: authorOf(key, comment.user), raw: payload })
    return out
  }
  return out
}
/** A repo's docs mapping, by its name as GitHub writes it (any case). */
function docsOf(options: GitHubOptions, repo: string) {
  const found = Object.entries(options.docs ?? {}).find(([name]) => name.toLowerCase() === repo.toLowerCase())
  return found ? found[1] : null
}

const CHANNEL_SEGMENT = /^[a-z0-9][a-z0-9_-]*$/
const SLUG = /^[a-z0-9][a-z0-9_-]{0,127}$/
const encodePath = (path: string) => path.split('/').map(encodeURIComponent).join('/')
function toBase64(text: string): string {
  const bytes = new TextEncoder().encode(text)
  let binary = ''
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
  return btoa(binary)
}
const fromBase64 = (value: string) => new TextDecoder().decode(Uint8Array.from(atob(value.replace(/\s/g, '')), (char) => char.charCodeAt(0)))

/** GitHub's reaction for a board emoji, when it has one. */
const REACTIONS: Record<string, string> = { '+1': '+1', thumbsup: '+1', thumbs_up: '+1', '-1': '-1', thumbsdown: '-1', thumbs_down: '-1', laughing: 'laugh', laugh: 'laugh', smile: 'laugh', confused: 'confused', heart: 'heart', tada: 'hooray', party: 'hooray', hooray: 'hooray', rocket: 'rocket', eyes: 'eyes' }

/** GitHub as a sync provider: its webhooks in, comments out as the app. */
export function githubProvider(options: GitHubOptions): SyncProvider<PlatformEvent> {
  const api = (options.apiBase ?? 'https://api.github.com').replace(/\/+$/, '')
  const webhookSecret = secretReader(options.webhookSecret, 'the GitHub webhook secret')
  const token = options.token === undefined ? null : isSecret(options.token) ? ((secret) => () => readSecret(secret, 'the GitHub token'))(options.token) : options.token
  const where = (target: string, key: string) => {
    const found = target.slice(key.length + 1).match(/^([^/:]+\/[^/:]+)(?::(\d+))?$/)
    if (!found) throw new SyncRefused(target + " isn't a GitHub repo or issue")
    return { repo: found[1]!, number: found[2] ? Number(found[2]) : null }
  }
  const github = async (repo: string, method: string, path: string, body?: unknown): Promise<any> => {
    if (!token) throw new SyncRefused('no GitHub token is configured')
    const response = await fetch(api + '/repos/' + repo + path, {
      method,
      headers: { authorization: 'Bearer ' + (await token(repo)), accept: 'application/vnd.github+json', 'content-type': 'application/json', 'user-agent': 'boards-sync', 'x-github-api-version': '2022-11-28' },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    })
    if (response.ok) return response.status === 204 ? null : response.json()
    const text = (await response.text()).slice(0, 300)
    const said = 'GitHub answered ' + response.status + ' to ' + method + ' ' + path + ': ' + text
    if (response.status === 429 || response.status >= 500 || (response.status === 403 && /rate limit/i.test(text))) throw new SyncRetry(said)
    throw new SyncRefused(said)
  }
  /** A file's contents and blob SHA at a ref, or null when it isn't there. */
  const contents = async (repo: string, path: string, ref: string): Promise<{ sha: string; text: string } | null> => {
    if (!token) throw new SyncRefused('no GitHub token is configured')
    const response = await fetch(api + '/repos/' + repo + '/contents/' + encodePath(path) + '?ref=' + encodeURIComponent(ref), {
      headers: { authorization: 'Bearer ' + (await token(repo)), accept: 'application/vnd.github+json', 'user-agent': 'boards-sync', 'x-github-api-version': '2022-11-28' },
    })
    if (response.status === 404) return null
    if (!response.ok) {
      const said = 'GitHub answered ' + response.status + ' to GET contents/' + path + ': ' + (await response.text()).slice(0, 300)
      if (response.status === 429 || response.status >= 500) throw new SyncRetry(said)
      throw new SyncRefused(said)
    }
    const file = (await response.json()) as { sha: string; content?: string; encoding?: string; type?: string }
    if (file.type !== 'file' || file.content === undefined) return null
    return { sha: file.sha, text: fromBase64(file.content) }
  }
  /** The board doc a repo file is: its channel and slug, or null when its path can't be one. */
  const docOfFile = (repo: string, path: string) => {
    const docs = docsOf(options, repo)
    if (!docs || !path.startsWith(docs.dir + '/') || !path.endsWith('.md')) return null
    const parts = path.slice(docs.dir.length + 1, -3).split('/')
    const slug = parts.pop()!
    if (!SLUG.test(slug) || !parts.every((part) => CHANNEL_SEGMENT.test(part))) return null
    return { channel: [docs.channel, ...parts].join('/'), slug }
  }
  /** The repo file a board doc is, or null when its path is outside the repo's docs channel. */
  const fileOfDoc = (repo: string, docPath: string) => {
    const docs = docsOf(options, repo)
    if (!docs || !docPath.startsWith(docs.channel + '/')) return null
    return docs.dir + '/' + docPath.slice(docs.channel.length + 1) + '.md'
  }

  return {
    platform: 'github',

    docTarget(channel, key) {
      for (const [repo, docs] of Object.entries(options.docs ?? {})) if (channel === docs.channel || channel.startsWith(docs.channel + '/')) return key + ':' + repo + ':doc'
      return null
    },

    async doc(input, { key }) {
      const found = input.target.slice(key.length + 1).match(/^([^/:]+\/[^/:]+):doc:\d+$/)
      if (!found) throw new SyncRefused(input.target + " isn't a GitHub doc target")
      const repo = found[1]!
      const branch = docsOf(options, repo)?.branch ?? 'main'
      const write = async (method: 'PUT' | 'DELETE', path: string, body: Record<string, unknown>) => {
        try {
          await github(repo, method, '/contents/' + encodePath(path), { ...body, branch })
        } catch (error) {
          // A file changed between our read and our write: read it again on the next try.
          if (error instanceof SyncRefused && / answered 409 /.test(error.message)) throw new SyncRetry(error.message)
          throw error
        }
      }
      if (input.event === 'moved' && input.from) {
        const old = fileOfDoc(repo, input.from)
        const there = old ? await contents(repo, old, branch) : null
        if (old && there) await write('DELETE', old, { message: 'docs: move ' + old + ' to ' + (fileOfDoc(repo, input.doc.path) ?? input.doc.path) + ' (from the board)', sha: there.sha })
      }
      const path = fileOfDoc(repo, input.doc.path)
      if (!path) return
      const there = await contents(repo, path, branch)
      // The retry guard: a file that already says this needs no commit.
      if (there && there.text === input.body) return
      await write('PUT', path, {
        message: (there ? 'docs: update ' : 'docs: add ') + path + ' from the board (revision ' + input.doc.revision + (input.by ? ', ' + input.by : '') + ')',
        content: toBase64(input.body),
        ...(there ? { sha: there.sha } : {}),
      })
    },
    async receive(request, { key }) {
      const delivery = await verifyGitHub(request, await webhookSecret())
      if (!delivery) return { events: [], response: new Response('not signed by this app\n', { status: 401 }) }
      if (delivery.event === 'ping') return { events: [], response: new Response('pong\n') }
      const id = delivery.delivery || crypto.randomUUID()
      const events = githubEvents(key, delivery, options).map((event, n): InboxEvent<PlatformEvent> => ({
        id: id + ':' + n,
        thread: event.thread,
        channel: key + ':' + event.thread.split(':')[1],
        event: { ...event, raw: undefined },
        raw: delivery.payload,
      }))
      return { events }
    },

    async import(event, tools) {
      const { key, call, rootOf } = tools
      const from = key
      const repoChannel = key + ':' + event.thread.split(':')[1]
      const origin = (message?: string | null) => ({ thread: event.thread, ...(message ? { message } : {}) })
      switch (event.kind) {
        case 'root':
          return call('syncImport', { op: 'post', from, author: event.author, origin: { channel: repoChannel, thread: event.thread, subthread: null, message: event.message, context: null }, channel: event.channel, text: event.text, labels: event.labels, id: event.thread + ':' + event.message })
        case 'reply': {
          if (options.botUserId !== undefined && event.author.id === key + ':user:' + options.botUserId && (await ownEcho(tools, event.subthread ?? event.thread, event.message))) return { message: null }
          const re = await rootOf(event.thread)
          if (!re) return { message: null }
          return call('syncImport', { op: 'post', from, author: event.author, origin: { channel: repoChannel, thread: event.thread, subthread: event.subthread, message: event.message, context: null }, re, text: event.text, id: event.thread + ':' + event.message })
        }
        case 'edit':
          return call('syncImport', { op: 'edit', from, author: event.author, origin: origin(event.message), text: event.text.trim() || '(empty)' })
        case 'delete':
          return call('syncImport', { op: 'delete', from, author: event.author, origin: origin(event.message) })
        case 'labels':
          return call('syncImport', { op: 'labels', from, author: event.author, origin: origin(null), set: event.set, unset: event.unset })
        case 'docfile': {
          const at = docOfFile(event.repo, event.path)
          if (!at) {
            console.warn('[boards] sync ' + key + ': ' + event.path + " can't be a doc's path: left out")
            return null
          }
          // A file removed in the repo leaves its doc on the board: deleting is a person's call.
          if (event.removed) return null
          const after = await contents(event.repo, event.path, event.after)
          if (after === null) return null
          const before = /^0+$/.test(event.before) ? null : await contents(event.repo, event.path, event.before)
          return importDocFile(call, { channel: at.channel, slug: at.slug, before: before?.text ?? null, after: after.text, name: event.repo + '/' + event.path, link: 'https://github.com/' + event.repo + '/blob/' + event.after + '/' + encodePath(event.path) })
        }
      }
    },

    async post({ target, thread, message }, { key }) {
      const at = where(thread ?? target, key)
      if (at.number === null) {
        // A board thread synced to a repo: a new issue, its first line the title.
        const [title, ...rest] = message.text.split('\n')
        const issue = await github(at.repo, 'POST', '/issues', { title: (title ?? '').replace(/^#+\s*/, '').slice(0, 256) || 'From the board', body: rest.join('\n').trim() })
        return { thread: key + ':' + at.repo + ':' + issue.number, message: 'issue' }
      }
      const comment = await github(at.repo, 'POST', '/issues/' + at.number + '/comments', { body: message.text })
      return { thread: key + ':' + at.repo + ':' + at.number, message: 'comment-' + comment.id }
    },

    async edit({ copy, message }, { key }) {
      const at = where(copy.thread, key)
      const comment = copy.message.match(/^comment-(\d+)$/)?.[1]
      if (comment) await github(at.repo, 'PATCH', '/issues/comments/' + comment, { body: message.text })
    },

    async delete({ copy }, { key }) {
      const at = where(copy.thread, key)
      const comment = copy.message.match(/^comment-(\d+)$/)?.[1]
      if (comment) await github(at.repo, 'DELETE', '/issues/comments/' + comment)
    },

    async react({ copy, emoji, remove }, { key }) {
      const content = REACTIONS[emoji]
      // GitHub takes eight reactions, and removing one takes its ID: the rest stay on the board.
      if (!content || remove) return
      const at = where(copy.thread, key)
      const comment = copy.message.match(/^comment-(\d+)$/)?.[1]
      if (comment) await github(at.repo, 'POST', '/issues/comments/' + comment + '/reactions', { content })
      else if (copy.message === 'issue' && at.number !== null) await github(at.repo, 'POST', '/issues/' + at.number + '/reactions', { content })
    },
  }
}
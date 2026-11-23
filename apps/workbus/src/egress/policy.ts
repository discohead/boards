// The egress policy (design/workbus.md §5.4): what a seat's outbound request may do, decided from
// the request alone, before it leaves. Pure, so scripts/egress-check.ts runs it in node.
import { isPrivateOrLocalHost } from 'agents/webfetch'

/**
 * Who is asking, set by the app when it hands out the egress (never by the seat):
 * - web: reading. GET or HEAD to any public host, with no credentials.
 * - sandbox: a seat's container or code. Reading as web, plus writes to GitHub, with the GitHub
 *   App's installation token added on the way out.
 */
export type EgressMode = 'web' | 'sandbox'
export type EgressProps = { seat: string; mode: EgressMode; /** The session's thread, for the log line. */ thread?: string }

/** Where the GitHub App's token goes, and the only hosts a sandbox may write to. */
export const GITHUB_HOSTS = ['github.com', 'api.github.com', 'codeload.github.com', 'uploads.github.com']

const READS = new Set(['GET', 'HEAD'])
/** Headers a seat may not set: credentials are the egress's to add, and cookies never leave. */
export const STRIPPED = ['authorization', 'proxy-authorization', 'cookie', 'x-api-key']

export type Decision =
  | { ok: true; credential: 'github' | null; repo: { owner: string; name: string } | null; write?: GitHubWrite }
  | { ok: false; status: number; reason: string }

/** The repository a GitHub URL is about, if any: owner and name, from the host's own path shape. */
export function githubRepo(url: URL): { owner: string; name: string } | null {
  const parts = url.pathname.split('/').filter(Boolean)
  const [a, b, c] = url.hostname === 'api.github.com' ? (parts[0] === 'repos' ? parts.slice(1) : []) : parts
  void c
  if (!a || !b) return null
  if (!/^[A-Za-z0-9-]{1,39}$/.test(a)) return null
  const name = b.replace(/\.git$/, '')
  if (!/^[A-Za-z0-9._-]{1,100}$/.test(name)) return null
  return { owner: a, name }
}

export function decide(method: string, href: string, props: EgressProps): Decision {
  let url: URL
  try {
    url = new URL(href)
  } catch {
    return { ok: false, status: 400, reason: 'not a URL' }
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return { ok: false, status: 403, reason: 'scheme ' + url.protocol + ' not allowed' }
  if (url.username || url.password) return { ok: false, status: 403, reason: 'credentials in the URL' }
  if (isPrivateOrLocalHost(url.hostname)) return { ok: false, status: 403, reason: 'private or local host ' + url.hostname }
  const verb = method.toUpperCase()
  const github = GITHUB_HOSTS.includes(url.hostname)
  if (READS.has(verb)) {
    // Reading GitHub from a sandbox carries the app's token, so private repos it's installed on can be cloned.
    const repo = props.mode === 'sandbox' && github ? githubRepo(url) : null
    return { ok: true, credential: repo && url.protocol === 'https:' ? 'github' : null, repo }
  }
  if (props.mode !== 'sandbox') return { ok: false, status: 405, reason: verb + ' not allowed: web reads only' }
  if (!github) return { ok: false, status: 405, reason: verb + ' to ' + url.hostname + ' not allowed: a sandbox writes only to GitHub' }
  if (url.protocol !== 'https:') return { ok: false, status: 403, reason: 'GitHub only over https' }
  const repo = githubRepo(url)
  if (!repo) return { ok: false, status: 403, reason: verb + ' to GitHub outside a repository' }
  const write = githubWrite(verb, url)
  if (!write.ok) return { ok: false, status: 403, reason: write.reason }
  return { ok: true, credential: 'github', repo, write: write.kind }
}

/**
 * The GitHub writes a sandbox may make (the user's rule, with branch protection behind it): push to
 * a branch that isn't the default branch or main, open a pull request, comment, and edit the title
 * or body of its own pull request. Fetching (git-upload-pack) is a POST too, and is a read.
 * Everything else is refused: contents PUT and DELETE, ref writes, merges, reviews, settings.
 */
export type GitHubWrite = 'upload-pack' | 'receive-pack' | 'pull-create' | 'comment' | 'pull-edit'

export function githubWrite(method: string, url: URL): { ok: true; kind: GitHubWrite } | { ok: false; reason: string } {
  const parts = url.pathname.split('/').filter(Boolean)
  if (url.hostname === 'github.com' && method === 'POST' && parts.length === 3) {
    if (parts[2] === 'git-upload-pack') return { ok: true, kind: 'upload-pack' }
    if (parts[2] === 'git-receive-pack') return { ok: true, kind: 'receive-pack' }
  }
  if (url.hostname === 'api.github.com' && parts[0] === 'repos') {
    const [, , , what, n, sub, extra] = parts
    const number = n !== undefined && /^\d+$/.test(n)
    if (method === 'POST' && what === 'pulls' && n === undefined) return { ok: true, kind: 'pull-create' }
    if (method === 'POST' && (what === 'issues' || what === 'pulls') && number && sub === 'comments' && extra === undefined) return { ok: true, kind: 'comment' }
    if (method === 'PATCH' && what === 'pulls' && number && sub === undefined) return { ok: true, kind: 'pull-edit' }
    if (what === 'pulls' && sub === 'merge') return { ok: false, reason: 'merging a pull request is the principal’s, not a seat’s' }
    if (what === 'contents') return { ok: false, reason: method + ' to repository contents is not allowed: push a branch and open a pull request' }
    if (what === 'git') return { ok: false, reason: method + ' to git refs or objects through the API is not allowed: push a branch' }
  }
  return { ok: false, reason: method + ' ' + url.hostname + url.pathname + ' is not a GitHub write a seat may make' }
}

/** One ref update a push asks for. */
export type RefUpdate = { old: string; new: string; ref: string }

/**
 * The ref updates at the start of a git-receive-pack request: pkt-lines of "<old> <new> <ref>", the
 * first with capabilities after a NUL, up to a flush (0000). Returns null until the flush has
 * arrived, and the length of that command section, so the caller knows where the pack begins.
 */
export function receivePackCommands(bytes: Uint8Array): { updates: RefUpdate[]; length: number } | null {
  const text = new TextDecoder('latin1')
  const updates: RefUpdate[] = []
  let at = 0
  while (at + 4 <= bytes.length) {
    const size = parseInt(text.decode(bytes.subarray(at, at + 4)), 16)
    if (Number.isNaN(size)) throw new Error('not a pkt-line')
    if (size === 0) return { updates, length: at + 4 }
    if (size < 4) throw new Error('bad pkt-line length ' + size)
    if (at + size > bytes.length) return null
    const line = text.decode(bytes.subarray(at + 4, at + size)).split('\0')[0]!.replace(/\n$/, '')
    const [old, next, ref] = line.split(' ')
    if (!old || !next || !ref) throw new Error('bad ref update: ' + line.slice(0, 80))
    updates.push({ old, new: next, ref })
    at += size
  }
  return null
}

/** A seat's own branches: refs/heads/seat/<seat key>/<topic>. The only branches it may push or delete. */
export function seatBranchPrefix(seat: string): string {
  return 'seat/' + seat + '/'
}

/**
 * Whether a push may go: every ref update, deletions included, is a branch in the seat's own
 * namespace (refs/heads/seat/<seat>/...). The seat comes from the egress's props, never the client.
 */
export function pushAllowed(updates: readonly RefUpdate[], seat: string): { ok: true } | { ok: false; reason: string } {
  if (!updates.length) return { ok: false, reason: 'a push with no ref updates' }
  const prefix = 'refs/heads/' + seatBranchPrefix(seat)
  const outside = updates.find((update) => !update.ref.startsWith(prefix) || update.ref.length === prefix.length || update.ref.includes('/../') || update.ref.endsWith('/'))
  if (outside) return { ok: false, reason: 'a push to ' + outside.ref + ' is not allowed: seat ' + seat + ' pushes only to ' + prefix + '<topic>, then opens a pull request' }
  return { ok: true }
}

/** Whether a pull request may be opened: its head is one of the seat's own branches, in this repository. */
export function pullHeadAllowed(head: unknown, owner: string, seat: string): { ok: true } | { ok: false; reason: string } {
  if (typeof head !== 'string' || !head) return { ok: false, reason: 'a pull request needs a head branch' }
  const [headOwner, branch] = head.includes(':') ? (head.split(':', 2) as [string, string]) : [owner, head]
  if (headOwner.toLowerCase() !== owner.toLowerCase()) return { ok: false, reason: 'a pull request from another repository (' + headOwner + ') is not allowed' }
  const prefix = seatBranchPrefix(seat)
  if (!branch.startsWith(prefix) || branch.length === prefix.length) return { ok: false, reason: 'a pull request from ' + branch + ' is not allowed: seat ' + seat + '’s head branches are ' + prefix + '<topic>' }
  return { ok: true }
}

/** The fields a seat may change on its own pull request. */
export const PULL_EDIT_FIELDS = new Set(['title', 'body'])

/** One line per request, for the logs: who, where, what, and how it went. */
export type EgressLog = {
  egress: 1
  seat: string
  thread?: string
  mode: EgressMode | 'browser' | 'search'
  method: string
  host: string
  path: string
  status: number
  bytes: number
  ms: number
  credential: 'github' | null
  refused?: string
}

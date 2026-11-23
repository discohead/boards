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
export type EgressProps = { seat: string; mode: EgressMode }

/** Where the GitHub App's token goes, and the only hosts a sandbox may write to. */
export const GITHUB_HOSTS = ['github.com', 'api.github.com', 'codeload.github.com', 'uploads.github.com']

const READS = new Set(['GET', 'HEAD'])
/** Headers a seat may not set: credentials are the egress's to add, and cookies never leave. */
export const STRIPPED = ['authorization', 'proxy-authorization', 'cookie', 'x-api-key']

export type Decision =
  | { ok: true; credential: 'github' | null; repo: { owner: string; name: string } | null }
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
  return { ok: true, credential: 'github', repo }
}

/** One line per request, for the logs: who, where, what, and how it went. */
export type EgressLog = {
  egress: 1
  seat: string
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

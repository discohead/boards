// The factory's GitHub App: an app JWT signed with its key, and installation tokens scoped to the
// repos a thread is about, as the template's credentials.ts asks
// Connect for them.
import { importPKCS8, SignJWT } from 'jose'
import { readSecret } from 'workbus/sync/secrets.ts'
import type { Env } from './env.ts'

const apiOf = (env: Env) => (env.GITHUB_API_BASE ?? 'https://api.github.com').replace(/\/+$/, '')
const headers = (token: string) => ({ authorization: 'Bearer ' + token, accept: 'application/vnd.github+json', 'user-agent': 'factory-cloudflare', 'x-github-api-version': '2022-11-28' })

let key: Promise<CryptoKey> | null = null
export async function appJwt(env: Env): Promise<string> {
  key ??= readSecret(env.GITHUB_APP_PRIVATE_KEY, 'the GitHub app' + "'" + 's private key').then((pem) => importPKCS8(pem.replace(/\\n/g, '\n'), 'RS256'))
  const now = Math.floor(Date.now() / 1000)
  return new SignJWT({}).setProtectedHeader({ alg: 'RS256' }).setIssuer(env.GITHUB_APP_ID).setIssuedAt(now - 30).setExpirationTime(now + 540).sign(await key)
}

const installations = new Map<string, number>()
async function installationOf(env: Env, owner: string, repo: string): Promise<number> {
  const known = installations.get(owner)
  if (known) return known
  const response = await fetch(apiOf(env) + '/repos/' + owner + '/' + repo + '/installation', { headers: headers(await appJwt(env)) })
  if (!response.ok) throw new Error('the GitHub app isn’t installed on ' + owner + '/' + repo + ' (' + response.status + ')')
  const { id } = (await response.json()) as { id: number }
  installations.set(owner, id)
  return id
}

const tokens = new Map<string, { token: string; until: number }>()

/** An installation token for an organization (its Projects), cached until five minutes before it ends. */
export async function orgToken(env: Env, org: string): Promise<string> {
  const cacheKey = 'org:' + org
  const cached = tokens.get(cacheKey)
  if (cached && cached.until > Date.now() + 5 * 60 * 1000) return cached.token
  const found = await fetch(apiOf(env) + '/orgs/' + org + '/installation', { headers: headers(await appJwt(env)) })
  if (!found.ok) throw new Error('the GitHub app isn’t installed on ' + org + ' (' + found.status + ')')
  const { id } = (await found.json()) as { id: number }
  const response = await fetch(apiOf(env) + '/app/installations/' + id + '/access_tokens', { method: 'POST', headers: headers(await appJwt(env)) })
  if (!response.ok) throw new Error('no GitHub token for ' + org + ': ' + response.status + ' ' + (await response.text()).slice(0, 200))
  const body = (await response.json()) as { token: string; expires_at: string }
  tokens.set(cacheKey, { token: body.token, until: Date.parse(body.expires_at) })
  return body.token
}

/** An installation token for repos (owner/name, one owner), cached until five minutes before it ends. */
export async function repoToken(env: Env, repos: readonly string[]): Promise<string | null> {
  const owner = repos[0]?.split('/')[0]
  if (!owner) return null
  const names = repos.filter((repo) => repo.split('/')[0] === owner).map((repo) => repo.split('/')[1]!).sort()
  const cacheKey = owner + '/' + names.join(',')
  const cached = tokens.get(cacheKey)
  if (cached && cached.until > Date.now() + 5 * 60 * 1000) return cached.token
  const installation = await installationOf(env, owner, names[0]!)
  const response = await fetch(apiOf(env) + '/app/installations/' + installation + '/access_tokens', {
    method: 'POST',
    headers: { ...headers(await appJwt(env)), 'content-type': 'application/json' },
    body: JSON.stringify({ repositories: names }),
  })
  if (!response.ok) throw new Error('no GitHub token for ' + cacheKey + ': ' + response.status + ' ' + (await response.text()).slice(0, 200))
  const body = (await response.json()) as { token: string; expires_at: string }
  tokens.set(cacheKey, { token: body.token, until: Date.parse(body.expires_at) })
  return body.token
}

/** The repos the app is installed on, for the launcher: [] when it can't tell. */
export async function installedRepos(env: Env): Promise<string[]> {
  const list = await fetch(apiOf(env) + '/app/installations', { headers: headers(await appJwt(env)) })
  if (!list.ok) return []
  const repos: string[] = []
  for (const installation of (await list.json()) as { id: number }[]) {
    const tokenResponse = await fetch(apiOf(env) + '/app/installations/' + installation.id + '/access_tokens', { method: 'POST', headers: headers(await appJwt(env)) })
    if (!tokenResponse.ok) continue
    const { token } = (await tokenResponse.json()) as { token: string }
    const page = await fetch(apiOf(env) + '/installation/repositories?per_page=100', { headers: headers(token) })
    if (page.ok) repos.push(...((await page.json()) as { repositories: { full_name: string }[] }).repositories.map((repo) => repo.full_name))
  }
  return repos
}
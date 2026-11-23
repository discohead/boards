// The "Workbus" GitHub App (design/workbus.md §5.4): an app JWT signed with its key, and an
// installation token per repository owner, minted on demand and cached until five minutes before it
// expires. Its id and key are in Secrets Store; only the egress reads them, and no seat sees a token.
import { importPKCS8, SignJWT } from 'jose'
import { readSecret } from 'workbus/sync/secrets.ts'

export type GitHubAppEnv = {
  GITHUB_APP_ID: SecretsStoreSecret | string
  GITHUB_APP_KEY: SecretsStoreSecret | string
}

const API = 'https://api.github.com'
const headers = (token: string) => ({ authorization: 'Bearer ' + token, accept: 'application/vnd.github+json', 'user-agent': 'workbus-egress', 'x-github-api-version': '2022-11-28' })

let app: Promise<{ id: string; key: CryptoKey }> | null = null

async function appJwt(env: GitHubAppEnv): Promise<string> {
  app ??= (async () => {
    const [id, pem] = await Promise.all([readSecret(env.GITHUB_APP_ID, 'the GitHub App id'), readSecret(env.GITHUB_APP_KEY, "the GitHub App's key")])
    return { id: id.trim(), key: await importPKCS8(pem.replace(/\\n/g, '\n'), 'RS256') }
  })().catch((error) => {
    app = null
    throw error
  })
  const { id, key } = await app
  const now = Math.floor(Date.now() / 1000)
  return new SignJWT({}).setProtectedHeader({ alg: 'RS256' }).setIssuer(id).setIssuedAt(now - 30).setExpirationTime(now + 540).sign(key)
}

const tokens = new Map<string, { token: string; until: number }>()

/** An installation token for the installation that covers owner/name, or null when the app isn't installed there. */
export async function installationToken(env: GitHubAppEnv, owner: string, name: string, fetcher: typeof fetch = fetch): Promise<string | null> {
  const key = owner.toLowerCase()
  const cached = tokens.get(key)
  if (cached && cached.until > Date.now() + 5 * 60 * 1000) return cached.token
  const jwt = await appJwt(env)
  const found = await fetcher(API + '/repos/' + owner + '/' + name + '/installation', { headers: headers(jwt) })
  if (found.status === 404) return null
  if (!found.ok) throw new Error('GitHub App installation lookup for ' + owner + '/' + name + ': ' + found.status)
  const { id } = (await found.json()) as { id: number }
  const minted = await fetcher(API + '/app/installations/' + id + '/access_tokens', { method: 'POST', headers: headers(jwt) })
  if (!minted.ok) throw new Error('GitHub installation token for ' + owner + ': ' + minted.status + ' ' + (await minted.text()).slice(0, 200))
  const body = (await minted.json()) as { token: string; expires_at: string }
  tokens.set(key, { token: body.token, until: Date.parse(body.expires_at) })
  return body.token
}

let login: Promise<string> | null = null

/** The app's own GitHub login ("<slug>[bot]"): what a pull request the seats opened is authored by. */
export function appLogin(env: GitHubAppEnv, fetcher: typeof fetch = fetch): Promise<string> {
  login ??= appJwt(env)
    .then((jwt) => fetcher(API + '/app', { headers: headers(jwt) }))
    .then(async (response) => {
      if (!response.ok) throw new Error('GitHub App: ' + response.status)
      return ((await response.json()) as { slug: string }).slug + '[bot]'
    })
    .catch((error) => {
      login = null
      throw error
    })
  return login
}

/** Who opened a pull request. */
export async function pullAuthor(owner: string, name: string, number: string, token: string, fetcher: typeof fetch = fetch): Promise<string> {
  const response = await fetcher(API + '/repos/' + owner + '/' + name + '/pulls/' + number, { headers: headers(token) })
  if (!response.ok) throw new Error('GitHub pull request ' + owner + '/' + name + '#' + number + ': ' + response.status)
  return ((await response.json()) as { user: { login: string } }).user.login
}

/** The repositories each installation of the app can reach, by full name. The tokens stay here. */
export async function installedRepositories(env: GitHubAppEnv, fetcher: typeof fetch = fetch): Promise<{ installation: number; account: string; permissions: Record<string, string>; repos: string[] }[]> {
  const jwt = await appJwt(env)
  const listed = await fetcher(API + '/app/installations', { headers: headers(jwt) })
  if (!listed.ok) throw new Error('GitHub App installations: ' + listed.status)
  const out: { installation: number; account: string; permissions: Record<string, string>; repos: string[] }[] = []
  for (const installation of (await listed.json()) as { id: number; account: { login: string }; permissions: Record<string, string> }[]) {
    const minted = await fetcher(API + '/app/installations/' + installation.id + '/access_tokens', { method: 'POST', headers: headers(jwt) })
    if (!minted.ok) throw new Error('GitHub installation token: ' + minted.status)
    const { token } = (await minted.json()) as { token: string }
    const page = await fetcher(API + '/installation/repositories?per_page=100', { headers: headers(token) })
    const { repositories } = (await page.json()) as { repositories: { full_name: string }[] }
    out.push({ installation: installation.id, account: installation.account.login, permissions: installation.permissions, repos: repositories.map((repo) => repo.full_name) })
  }
  return out
}

/** The header the token goes in: git's smart HTTP takes Basic, the REST API takes a bearer. */
export function authorization(host: string, token: string): string {
  return host === 'api.github.com' || host === 'uploads.github.com' ? 'Bearer ' + token : 'Basic ' + btoa('x-access-token:' + token)
}

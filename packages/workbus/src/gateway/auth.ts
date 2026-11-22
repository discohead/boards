// Who a request is. People hold tokens the board's issuer signs (its key is a Worker secret) or come
// through Cloudflare Access; CI holds GitHub Actions tokens; any OIDC issuer a grant names is trusted
// for its tokens. A Worker in the account is its binding (binding.ts), never a token.
import { createLocalJWKSet, createRemoteJWKSet, decodeJwt, importJWK, jwtVerify, SignJWT, type JWK, type JWTVerifyGetKey } from 'jose'
import { unauthorized } from '../errors.ts'
import type { Principal } from '../ledger/core.ts'

export type IssuerKey = JWK & { kid: string }
export const issuerOf = (origin: string) => origin.replace(/\/+$/, '') + '/issuer'
export const GITHUB_ISSUER = 'https://token.actions.githubusercontent.com'

export function publicJwks(key: IssuerKey) {
  const { d: _d, p: _p, q: _q, dp: _dp, dq: _dq, qi: _qi, ...pub } = key
  return { keys: [{ ...pub, alg: key.alg ?? 'ES256', use: 'sig' }] }
}

const remote = new Map<string, JWTVerifyGetKey>()
const keysFor = (url: string) => {
  let keys = remote.get(url)
  if (!keys) remote.set(url, (keys = createRemoteJWKSet(new URL(url))))
  return keys
}

export const issuerName = (iss: string) => {
  const url = new URL(iss)
  return (url.host + url.pathname.replace(/\/+$/, '')).replace(/[%:]/g, (char) => (char === '%' ? '%25' : '%3A'))
}

export type AuthOptions = {
  origin: string
  audience: string
  issuerKey: IssuerKey
  /** OIDC issuers the board's grants name: their tokens are trusted. */
  issuers: () => Promise<string[]>
  /** Cloudflare Access: its team and application, and who signing in through it is the board's owner (ownersOf). */
  access?: { team: string; aud: string; owners?: readonly string[] }
}

/**
 * The owners a deployment names, from code and ACCESS_OWNERS, as entries to match: an email (with an @,
 * any case) or an Access sub. Commas or newlines between them.
 */
export function ownersOf(...lists: (string | readonly string[] | null | undefined)[]): string[] {
  const out = new Set<string>()
  for (const list of lists)
    for (const entry of typeof list === 'string' ? list.split(/[,\n]/) : (list ?? [])) {
      const trimmed = entry.trim()
      if (trimmed) out.add(trimmed.includes('@') ? trimmed.toLowerCase() : trimmed)
    }
  return [...out]
}

/**
 * Whether an Access login is an owner: its sub is named, or its email is. The sub is the stable one
 * (an email can be renamed or given to someone else); an email is what's known before a first sign-in.
 */
export function isOwner(owners: readonly string[], sub: string, email: string): boolean {
  return owners.includes(sub) || owners.includes(email.toLowerCase())
}

const SUB = /^[a-z0-9](?:[a-z0-9._@-]{0,62}[a-z0-9])?$/

export async function authenticate(request: Request, options: AuthOptions): Promise<Principal> {
  const access = request.headers.get('cf-access-jwt-assertion')
  const header = request.headers.get('authorization')
  const bearer = header ? /^Bearer\s+(.+)$/i.exec(header)?.[1] : undefined
  if (!bearer && access && options.access) return fromAccess(access, options.access)
  if (!bearer) throw unauthorized('missing bearer token')
  let claims: Record<string, unknown>
  try {
    claims = decodeJwt(bearer) as Record<string, unknown>
  } catch {
    throw unauthorized('malformed token')
  }
  const iss = typeof claims.iss === 'string' ? claims.iss : '(none)'
  const verify = async (keys: JWTVerifyGetKey) => {
    try {
      return (await jwtVerify(bearer, keys, { issuer: iss, audience: options.audience })).payload as Record<string, unknown>
    } catch (error) {
      throw unauthorized('invalid token: ' + (error as Error).message)
    }
  }
  const expiresAt = (payload: Record<string, unknown>) => (typeof payload.exp === 'number' ? payload.exp * 1000 : null)
  if (iss === issuerOf(options.origin)) {
    const payload = await verify(createLocalJWKSet(publicJwks(options.issuerKey) as never))
    const sub = payload.sub
    if (typeof sub !== 'string' || !SUB.test(sub)) throw unauthorized('board token without a valid sub')
    const kind = payload.kind === 'workload' ? 'deployment' : 'person'
    const handle = typeof payload.handle === 'string' ? payload.handle : sub
    const role = payload.role === 'viewer' || payload.role === 'member' || payload.role === 'owner' ? payload.role : 'owner'
    return { id: (kind === 'person' ? 'workbus:user:' : 'worker:') + sub, kind, handle, name: typeof payload.name === 'string' ? payload.name : handle, facts: { issuer: 'workbus', claims: payload }, expiresAt: expiresAt(payload), ...(kind === 'person' ? { role } : {}) }
  }
  if (iss === GITHUB_ISSUER) {
    const payload = await verify(keysFor(GITHUB_ISSUER + '/.well-known/jwks'))
    const id = String(payload.repository_id ?? '')
    if (!id) throw unauthorized('github token without repository_id')
    return { id: 'github:repo:' + id, kind: 'workflow', handle: String(payload.repository ?? id), name: String(payload.repository ?? id), facts: { issuer: 'github', claims: payload }, expiresAt: expiresAt(payload) }
  }
  if (/^https:\/\//.test(iss) && (await options.issuers()).includes(iss)) {
    const discovery = await fetch(iss.replace(/\/+$/, '') + '/.well-known/openid-configuration', { redirect: 'manual', signal: AbortSignal.timeout(5000) }).then((response) => (response.ok ? response.json() : null)).catch(() => null) as { issuer?: string; jwks_uri?: string } | null
    if (!discovery || discovery.issuer !== iss || !discovery.jwks_uri?.startsWith('https://')) throw unauthorized('cannot load keys for issuer ' + iss)
    const payload = await verify(keysFor(discovery.jwks_uri))
    const sub = payload.sub
    if (typeof sub !== 'string' || !sub) throw unauthorized('token from ' + iss + ' without sub')
    if (/[\s+\]]/.test(sub)) throw unauthorized('token from ' + iss + " has a sub with a +, a ], or a space, which a principal's ID can't hold")
    return { id: 'oidc:' + issuerName(iss) + ':' + sub, kind: 'workflow', handle: sub.slice(0, 128), name: sub.slice(0, 128), facts: { issuer: iss, claims: payload }, expiresAt: expiresAt(payload) }
  }
  throw unauthorized('untrusted issuer: ' + iss)
}

async function fromAccess(token: string, access: { team: string; aud: string; owners?: readonly string[] }): Promise<Principal> {
  const iss = 'https://' + access.team + '.cloudflareaccess.com'
  let payload: Record<string, unknown>
  try {
    payload = (await jwtVerify(token, keysFor(iss + '/cdn-cgi/access/certs'), { issuer: iss, audience: access.aud })).payload as Record<string, unknown>
  } catch (error) {
    throw unauthorized('invalid Access token: ' + (error as Error).message)
  }
  const email = typeof payload.email === 'string' ? payload.email : undefined
  const sub = String(payload.sub ?? email ?? '')
  const handle = email ? email.split('@')[0]!.toLowerCase().replace(/[^a-z0-9._-]/g, '-') : sub
  // Only a person's login can be an owner: a service token never is.
  const role = email && isOwner(access.owners ?? [], sub, email) ? 'owner' : 'member'
  return { id: (email ? 'access:user:' : 'access:service:') + sub, kind: email ? 'person' : 'workflow', handle, name: email ?? handle, facts: { issuer: 'access', claims: payload }, expiresAt: typeof payload.exp === 'number' ? payload.exp * 1000 : null, role }
}

/** A token for sub, for the board at audience, signed by the board's issuer. */
export async function mint(options: { origin: string; key: IssuerKey; sub: string; audience: string; ttlSeconds?: number; claims?: Record<string, unknown> }) {
  const key = await importJWK(options.key, options.key.alg ?? 'ES256')
  return new SignJWT(options.claims ?? {})
    .setProtectedHeader({ alg: options.key.alg ?? 'ES256', kid: options.key.kid })
    .setIssuer(issuerOf(options.origin))
    .setSubject(options.sub)
    .setAudience(options.audience)
    .setIssuedAt()
    .setExpirationTime(Math.floor(Date.now() / 1000) + (options.ttlSeconds ?? 3600))
    .sign(key)
}

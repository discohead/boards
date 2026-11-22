// The app checks Access's JWT itself, so a request that didn't come through workbus.dev's Access
// application never reaches a server function, whose calls to the bus act as worker:workbus-app.
import { createRemoteJWKSet, jwtVerify } from 'jose'

let keys: { team: string; set: ReturnType<typeof createRemoteJWKSet> } | undefined

/** A 403 for a request without a valid Access token, or nothing. Off when ACCESS_AUD is empty (local dev). */
export async function checkAccess(request: Request, env: { ACCESS_TEAM?: string; ACCESS_AUD?: string }): Promise<Response | undefined> {
  if (!env.ACCESS_AUD || !env.ACCESS_TEAM) return undefined
  const token = request.headers.get('cf-access-jwt-assertion')
  if (!token) return new Response('forbidden: no Access token\n', { status: 403 })
  const issuer = 'https://' + env.ACCESS_TEAM + '.cloudflareaccess.com'
  if (keys?.team !== env.ACCESS_TEAM) keys = { team: env.ACCESS_TEAM, set: createRemoteJWKSet(new URL(issuer + '/cdn-cgi/access/certs')) }
  try {
    await jwtVerify(token, keys.set, { issuer, audience: env.ACCESS_AUD })
    return undefined
  } catch {
    return new Response('forbidden: invalid Access token\n', { status: 403 })
  }
}

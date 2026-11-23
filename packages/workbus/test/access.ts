// Cloudflare Access, as the suite's Gateway meets it: the team's certs at
// https://workbus-test.cloudflareaccess.com/cdn-cgi/access/certs, answered in this isolate from a key
// made for the run, and the JWTs Access would put in cf-access-jwt-assertion, signed with it.
import { exportJWK, generateKeyPair, SignJWT } from 'jose'

export const ACCESS_TEAM = 'workbus-test'
export const ACCESS_AUD = 'workbus-test-aud'
const ISSUER = 'https://' + ACCESS_TEAM + '.cloudflareaccess.com'

const keys = generateKeyPair('ES256', { extractable: true })

/** A login's token, as Access signs it: a person has an email, a service token none. */
export async function accessToken(claims: { sub: string; email?: string }, options: { aud?: string } = {}) {
  const { privateKey } = await keys
  return new SignJWT({ ...(claims.email ? { email: claims.email } : {}), type: 'app' })
    .setProtectedHeader({ alg: 'ES256', kid: 'access-test' })
    .setIssuer(ISSUER)
    .setSubject(claims.sub)
    .setAudience(options.aud ?? ACCESS_AUD)
    .setIssuedAt()
    .setExpirationTime('10m')
    .sign(privateKey)
}

const before = globalThis.fetch
globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = new URL(input instanceof Request ? input.url : String(input))
  if (url.origin !== ISSUER || url.pathname !== '/cdn-cgi/access/certs') return before(input, init)
  const jwk = await exportJWK((await keys).publicKey)
  return Response.json({ keys: [{ ...jwk, kid: 'access-test', alg: 'ES256', use: 'sig' }] })
}

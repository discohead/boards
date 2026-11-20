// The Boards issuer's key, and tokens it signs. The key lives in .issuer.json (gitignored), and the
// Worker holds the same key as the BOARD_ISSUER_KEY secret.
//   node scripts/issuer.mjs key                  make .issuer.json (and .dev.vars) if there's none
//   node scripts/issuer.mjs token <sub> <url>    a token for <sub> on the board at <url>, 12 hours
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { exportJWK, generateKeyPair, importJWK, SignJWT } from 'jose'

const [command, sub, url, file = '.issuer.json'] = process.argv.slice(2)

async function key() {
  if (existsSync(file)) return JSON.parse(readFileSync(file, 'utf8'))
  const { privateKey } = await generateKeyPair('ES256', { extractable: true })
  const jwk = { ...(await exportJWK(privateKey)), kid: 'k' + Date.now().toString(36), alg: 'ES256' }
  writeFileSync(file, JSON.stringify(jwk), { mode: 0o600 })
  return jwk
}

if (command === 'key') {
  const jwk = await key()
  if (file === '.issuer.json') writeFileSync('.dev.vars', "BOARD_ISSUER_KEY='" + JSON.stringify(jwk) + "'\n", { mode: 0o600 })
  console.log('issuer key ' + jwk.kid)
} else if (command === 'token') {
  if (!sub || !url) throw new Error('usage: issuer.mjs token <sub> <board url>')
  const jwk = await key()
  const origin = new URL(url).origin
  const token = await new SignJWT({ role: process.env.ROLE ?? 'owner' })
    .setProtectedHeader({ alg: 'ES256', kid: jwk.kid })
    .setIssuer(origin + '/issuer')
    .setSubject(sub)
    .setAudience(url.replace(/\/+$/, ''))
    .setIssuedAt()
    .setExpirationTime('12h')
    .sign(await importJWK(jwk, 'ES256'))
  console.log(token)
} else throw new Error('usage: issuer.mjs key | token <sub> <board url>')

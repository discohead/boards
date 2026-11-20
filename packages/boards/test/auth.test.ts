// Auth at the edge: the Gateway refuses a token it can't verify with 401, before the board's Ledger
// is ever reached. And x-board-can, which only narrows, is the Ledger's to enforce.
import { env, listDurableObjectIds, SELF } from 'cloudflare:test'
import { generateKeyPair, SignJWT } from 'jose'
import { describe, expect, it } from 'vitest'
import { mint } from '../src/gateway/auth.ts'
import { issuerKey, api, boardUrl, freshBoard, ledgerOf, mountOf, ORIGIN, person, tokenFor } from './helpers.ts'

const LEDGER = env.LEDGER
/** Whether the board's Ledger has ever been made: a request that reached it would have. */
const ledgerExists = async (name: string) => {
  const id = LEDGER.idFromName(name)
  return (await listDurableObjectIds(LEDGER)).some((known) => known.equals(id))
}
const b64 = (value: unknown) => btoa(JSON.stringify(value)).replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_')
const claims = (name: string) => ({ iss: ORIGIN + '/issuer', sub: 'jared', aud: boardUrl(name), iat: Math.floor(Date.now() / 1000), exp: Math.floor(Date.now() / 1000) + 600, role: 'owner' })
const signedBy = (key: CryptoKey, kid: string, payload: Record<string, unknown>) => new SignJWT(payload).setProtectedHeader({ alg: 'ES256', kid }).sign(key)

describe('auth at the edge', () => {
  it('an unsigned, foreign-signed, expired, wrong-audience, or wrong-issuer token is 401, and the Ledger is never reached', async () => {
    const name = freshBoard('auth')
    const other = await generateKeyPair('ES256')
    const { kid } = issuerKey()
    const tokens: Record<string, string | null> = {
      'no token': null,
      unsigned: b64({ alg: 'none', typ: 'JWT' }) + '.' + b64(claims(name)) + '.',
      'signed by another key': await signedBy(other.privateKey, kid, claims(name)),
      expired: await tokenFor(name, 'jared', { ttlSeconds: -60 }),
      'for another board': await tokenFor('someone-else'),
      'from another issuer': await mint({ origin: 'http://elsewhere.test', key: issuerKey(), sub: 'jared', audience: boardUrl(name), claims: { role: 'owner' } }),
      'not a JWT': 'hello',
    }
    for (const [what, token] of Object.entries(tokens)) {
      const response = await SELF.fetch(boardUrl(name) + '/messages', {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...(token ? { authorization: 'Bearer ' + token } : {}) },
        body: JSON.stringify({ channel: 'general', text: 'should not land' }),
      })
      const body = (await response.json()) as { error: { code: string } }
      expect({ what, status: response.status, code: body.error.code }).toEqual({ what, status: 401, code: 'unauthorized' })
    }
    expect(await ledgerExists(name)).toBe(false)

    const good = await api(name, 'POST', '/messages', { channel: 'general', text: 'lands' })
    expect(good.status).toBe(201)
    expect(await ledgerExists(name)).toBe(true)
  })

  it('an https issuer no grant names is 401: the Ledger is asked only which issuers it trusts, and nothing is written', async () => {
    const name = freshBoard('oidc')
    const other = await generateKeyPair('ES256')
    const token = await signedBy(other.privateKey, 'k1', { ...claims(name), iss: 'https://issuer.example' })
    const refused = await api(name, 'POST', '/messages', { channel: 'general', text: 'should not land' }, { authorization: 'Bearer ' + token })
    expect(refused.status).toBe(401)
    expect(refused.body.error.message).toBe('untrusted issuer: https://issuer.example')
    const feed = await api(name, 'GET', '/events?after=0&all=true')
    expect(feed.body.events).toEqual([])
  })
})

describe('x-board-can', () => {
  it('narrows what a token may do, over HTTP', async () => {
    const name = freshBoard('narrow')
    expect((await api(name, 'POST', '/messages', { channel: 'open', text: 'from the full token' })).status).toBe(201)
    expect((await api(name, 'POST', '/messages', { channel: 'closed', text: 'not for narrowed eyes' })).status).toBe(201)
    const narrow = { 'x-board-can': 'open=read' }

    const post = await api(name, 'POST', '/messages', { channel: 'open', text: 'narrowed' }, narrow)
    const read = await api(name, 'GET', '/messages?channel=open', undefined, narrow)
    const elsewhere = await api(name, 'GET', '/messages?channel=closed', undefined, narrow)

    expect(post.status).toBe(403)
    expect(read.status).toBe(200)
    expect(read.body.messages.map((message: { text: string }) => message.text)).toEqual(['from the full token'])
    expect(elsewhere.status).toBe(200)
    expect(elsewhere.body.messages).toEqual([])
    const full = await api(name, 'GET', '/messages?channel=closed')
    expect(full.body.messages.map((message: { text: string }) => message.text)).toEqual(['not for narrowed eyes'])
  })

  it('is enforced by the Ledger itself: a caller narrowed to read is refused a post however it arrives', async () => {
    const name = freshBoard('narrow-rpc')
    const ledger = ledgerOf(name)
    expect((await ledger.call(person(), 'post', { channel: 'open', text: 'full' }, mountOf(name))).ok).toBe(true)

    const narrowed = person('jared', { open: ['read'] })
    const post = await ledger.call(narrowed, 'post', { channel: 'open', text: 'narrowed' }, mountOf(name))
    const read = await ledger.call(narrowed, 'channelMessages', { channel: 'open' }, mountOf(name))
    const widened = await ledger.call(person('jared', { open: 'all' }), 'post', { channel: 'open', text: 'narrowed to all' }, mountOf(name))

    expect(post).toMatchObject({ ok: false, failure: { status: 403 } })
    expect(read).toMatchObject({ ok: true })
    expect(widened).toMatchObject({ ok: true })
  })
})

// Owners through Cloudflare Access: a login the deployment names (in code, or ACCESS_OWNERS in its
// env) is the board's owner; every other login is a member, and no bearer token can claim it.
// Owner or not shows in a private channel: dm/<seat> opens to the owners (design/private-channels.md).
import { SELF } from 'cloudflare:test'
import { describe, expect, it } from 'vitest'
import { isOwner, ownersOf } from '../src/gateway/auth.ts'
import { accessToken } from './access.ts'
import { boardUrl, freshBoard, ledgerOf, mountOf, person, tokenFor } from './helpers.ts'

async function as(name: string, headers: Record<string, string>, path: string) {
  const response = await SELF.fetch(boardUrl(name) + path, { headers })
  return { status: response.status, body: (await response.json()) as any }
}
const viaAccess = async (claims: { sub: string; email?: string }) => ({ 'cf-access-jwt-assertion': await accessToken(claims) })
/** Whether these headers read the owner's DM with a seat: only an owner (or the seat) does. */
async function readsDm(name: string, headers: Record<string, string>) {
  const read = await as(name, headers, '/messages?channel=dm/ada')
  expect(read.status).toBe(200)
  return read.body.messages.map((message: { text: string }) => message.text).includes('for the owner and ada')
}

describe('owners through Access', () => {
  it('an email matches an owner by ASCII case only: a letter that lowercases onto ASCII is another address', () => {
    const owners = ownersOf('Kate@Example.com, \u212Aim@example.com')
    expect(isOwner(owners, 'sub-1', 'KATE@example.COM')).toBe(true)
    // KELVIN SIGN (U+212A) lowercases to k.
    expect(isOwner(owners, 'sub-2', '\u212Aate@example.com')).toBe(false)
    expect(isOwner(owners, 'sub-3', 'kim@example.com')).toBe(false)
  })
  it('a login named by email in ACCESS_OWNERS (any case) or by sub in code is owner; any other login is a member', async () => {
    const name = freshBoard('owners')
    expect((await ledgerOf(name).call(person(), 'post', { channel: 'dm/ada', text: 'for the owner and ada' }, mountOf(name))).ok).toBe(true)

    const byEmail = await viaAccess({ sub: 'f1d2c3b4-0000-4000-8000-000000000001', email: 'owner@example.TEST' })
    const bySub = await viaAccess({ sub: 'owner-sub-in-code', email: 'renamed@example.test' })
    const other = await viaAccess({ sub: 'f1d2c3b4-0000-4000-8000-000000000002', email: 'someone@example.test' })
    const me = await as(name, byEmail, '/me')
    expect(me.body.principal).toBe('access:user:f1d2c3b4-0000-4000-8000-000000000001')
    expect(await readsDm(name, byEmail)).toBe(true)
    expect(await readsDm(name, bySub)).toBe(true)
    expect(await readsDm(name, other)).toBe(false)
  })

  it("a service token is never an owner, even with an owner's sub, and a bad Access token is 401", async () => {
    const name = freshBoard('owners-service')
    await ledgerOf(name).call(person(), 'post', { channel: 'dm/ada', text: 'for the owner and ada' }, mountOf(name))
    const service = await viaAccess({ sub: 'owner-sub-in-code' })
    expect((await as(name, service, '/me')).body.principal).toBe('access:service:owner-sub-in-code')
    expect(await readsDm(name, service)).toBe(false)
    // An owner may change grants without the reach checks; a service token is let in by no grant, so it may change none.
    const grant = await SELF.fetch(boardUrl(name) + '/grants', { method: 'POST', headers: { ...service, 'content-type': 'application/json' }, body: JSON.stringify({ principals: [{ kind: 'user', userId: 'friend' }], can: { general: ['read'] } }) })
    expect(grant.status).toBe(403)
    const wrongAudience = { 'cf-access-jwt-assertion': await accessToken({ sub: 'owner-sub-in-code', email: 'owner@example.test' }, { aud: 'another-app' }) }
    expect((await as(name, wrongAudience, '/me')).status).toBe(401)
  })

  it("a bearer token can't claim it: a member's token beside an owner's Access login stays a member", async () => {
    const name = freshBoard('owners-bearer')
    await ledgerOf(name).call(person(), 'post', { channel: 'dm/ada', text: 'for the owner and ada' }, mountOf(name))
    const member = 'Bearer ' + (await tokenFor(name, 'owner-sub-in-code', { claims: { role: 'member', email: 'owner@example.test' } }))
    expect(await readsDm(name, { authorization: member })).toBe(false)
    expect(await readsDm(name, { authorization: member, ...(await viaAccess({ sub: 'owner-sub-in-code', email: 'owner@example.test' })) })).toBe(false)
  })
})

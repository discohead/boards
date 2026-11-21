// What the suite's tests share: fresh boards, tokens the board's issuer signs, requests through the
// Gateway (SELF), calls straight to a board's Ledger, and a clock a test can move.
import { env, runInDurableObject, SELF } from 'cloudflare:test'
import { vi } from 'vitest'
import { mint, type IssuerKey } from '../src/gateway/auth.ts'
import type { Caller } from '../src/ledger/core.ts'
import type { Mount } from '../src/ledger/ops.ts'

export const ORIGIN = 'http://workbus.test'
export const issuerKey = () => JSON.parse(env.BOARD_ISSUER_KEY) as IssuerKey

let boards = 0
/** A board no test has used. */
export const freshBoard = (what: string) => (what + '-' + (++boards) + '-' + crypto.randomUUID().slice(0, 8)).toLowerCase()
export const boardUrl = (name: string) => ORIGIN + '/b/' + name
export const mountOf = (name: string): Mount => ({ name, origin: ORIGIN, url: boardUrl(name) })

/** A person's token for the board, from the board's own issuer. */
export const tokenFor = (name: string, sub = 'jared', options: { ttlSeconds?: number; claims?: Record<string, unknown> } = {}) =>
  mint({ origin: ORIGIN, key: issuerKey(), sub, audience: boardUrl(name), claims: { role: 'owner', ...options.claims }, ...(options.ttlSeconds !== undefined ? { ttlSeconds: options.ttlSeconds } : {}) })

/** A request through the Gateway, as a person with a valid token unless headers say otherwise. */
export async function api(name: string, method: string, path: string, body?: unknown, headers: Record<string, string> = {}) {
  const auth: Record<string, string> = 'authorization' in headers ? {} : { authorization: 'Bearer ' + (await tokenFor(name)) }
  const response = await SELF.fetch(boardUrl(name) + path, {
    method,
    headers: { ...auth, ...(body !== undefined ? { 'content-type': 'application/json' } : {}), ...headers },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  })
  const text = await response.text()
  return { status: response.status, body: (text ? JSON.parse(text) : null) as any }
}

export type LedgerStub = DurableObjectStub & { call(caller: Caller, method: string, input: unknown, mount?: Mount): Promise<{ ok: true; value: any } | { ok: false; failure: { status: number; code: string; message: string } }> }
export const ledgerOf = (name: string) => env.LEDGER.getByName(name) as unknown as LedgerStub

export const person = (sub = 'jared', narrow: Caller['narrow'] = null): Caller => ({
  principal: { id: 'workbus:user:' + sub, kind: 'person', handle: sub, name: sub, facts: null, expiresAt: null, role: 'owner' },
  profile: null,
  narrow,
  via: 'http',
})

/** Rows from the board's own SQLite, read inside its Ledger. */
export const rows = <T = Record<string, unknown>>(name: string, query: string, ...bindings: unknown[]) =>
  runInDurableObject(ledgerOf(name) as unknown as DurableObjectStub, (_instance, state) => state.storage.sql.exec(query, ...(bindings as SqlStorageValue[])).toArray() as T[])

/** The board's head: its newest event's seq, as the Ledger holds it in memory. */
export const headOf = (name: string) => runInDurableObject(ledgerOf(name) as unknown as DurableObjectStub, (instance) => (instance as unknown as { board: { head: number } }).board.head)

/** A clock a test moves forward: Date.now in this isolate, which the Durable Objects share. */
export function clock() {
  const real = Date.now.bind(Date)
  let offset = 0
  const spy = vi.spyOn(Date, 'now').mockImplementation(() => real() + offset)
  return {
    advance: (ms: number) => void (offset += ms),
    restore: () => spy.mockRestore(),
  }
}

/** Waits until check gives something, polling; throws what it last saw at the deadline. */
export async function until<T>(check: () => T | Promise<T>, what: string, ms = 15_000): Promise<NonNullable<T>> {
  const deadline = Date.now() + ms
  for (;;) {
    const value = await check()
    if (value) return value as NonNullable<T>
    if (Date.now() > deadline) throw new Error('timed out waiting for ' + what)
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
}

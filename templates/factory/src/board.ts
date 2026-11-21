// The agent's handle on its board: the Ledger itself, over RPC, as this Worker, held to the
// factory's channels. No token and no HTTP: the binding is the credential.
import { parseCan } from 'workbus/ledger/access.ts'
import type { Caller } from 'workbus/ledger/core.ts'
import { AGENT_CAN, NAME } from './config.ts'
import type { Env } from './env.ts'

export const BOARD = NAME
export const AGENT_PRINCIPAL = 'worker:' + NAME

export const agentCaller = (): Caller => ({
  principal: { id: AGENT_PRINCIPAL, kind: 'deployment', handle: NAME, name: NAME, facts: null, expiresAt: null, own: true },
  profile: null,
  narrow: parseCan(AGENT_CAN),
  via: 'binding',
})

export const mountOf = (env: Env) => ({ name: BOARD, origin: env.BOARD_ORIGIN, url: env.BOARD_ORIGIN.replace(/\/+$/, '') + '/b/' + BOARD })

export type BoardCall = (method: string, input: Record<string, unknown>) => Promise<any>

/** One protocol method on the factory's board, as the agent: its answer, or a thrown error with the board's code. */
export function boardCall(env: Env): BoardCall {
  return async (method, input) => {
    const answer = await env.LEDGER.getByName(BOARD).call(agentCaller(), method, input, mountOf(env))
    if (!answer.ok) throw Object.assign(new Error(answer.failure.code + ': ' + answer.failure.message), { code: answer.failure.code, status: answer.failure.status })
    return answer.value
  }
}

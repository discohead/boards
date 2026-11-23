// The bus, as the app reaches it: the WORKBUS service binding (props name the principal
// workbus-app). Typed here by hand, since the binding's own types (Service<Workbus>) bring the
// framework's source into the app's typecheck. Only what the app calls is here.
import { env } from 'cloudflare:workers'

import { BOARD } from './board.ts'

type Answer = Promise<any>
export type Profile = { key: string; name: string; handle?: string; avatar?: string }

export type Board = {
  me(): Answer
  as(profile: Profile): Board
  narrow(can: unknown): Board
  post(channel: string, input: string | Record<string, unknown>): Answer
  reply(id: string, input: string | Record<string, unknown>): Answer
  message(id: string, range?: { after?: string; limit?: number }): Answer
  threads(query?: Record<string, unknown>): Answer
  setWake(key: string, input: { sink: string; rules: Record<string, unknown>; revision?: number }): Answer
  wakes(query?: { prefix?: string }): Answer
  deleteWake(key: string, opts?: { revision?: number }): Answer
  docs: {
    create(input: { channel: string; slug: string; body: string; id?: string }): Answer
    at(path: string): Answer
    read(id: string): Answer
  }
  tasks: {
    list(query?: Record<string, unknown>): Answer
  }
}

export const bus = (): Board => (env.WORKBUS as unknown as { board(name: string): Board }).board(BOARD)

/** A refusal across RPC is an Error whose message leads with the board's code. */
export const codeOf = (error: unknown) => (error instanceof Error ? /^([a-z_]+):/.exec(error.message)?.[1] ?? null : null)

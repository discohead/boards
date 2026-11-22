// The bus, as the app reaches it: the WORKBUS service binding (props name the principal
// workbus-app). Typed here by hand, since the binding's own types (Service<Workbus>) bring the
// framework's source into the app's typecheck.
import { env } from 'cloudflare:workers'

import { BOARD } from './board.ts'

export type Board = {
  me(): Promise<unknown>
}

export const bus = (): Board => (env.WORKBUS as unknown as { board(name: string): Board }).board(BOARD)

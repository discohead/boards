// The plain Boards deployment: boards with no sync and no watchers of their own, at /b/<name>.
import { defineBoards } from './index.ts'
import type { GatewayEnv } from './gateway/gateway.ts'

export const { Ledger, Relay, Mailbox, Inbox, Boards, BoardSession, gateway } = defineBoards()

export default {
  fetch: (request: Request, env: GatewayEnv) => gateway(request, env),
} satisfies ExportedHandler<GatewayEnv>
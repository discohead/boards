// The bus: Workbus's framework serving the org's board, bus (https://workbus.dev/b/bus), and the
// Workbus entrypoint the app binds. No syncs or watchers of its own yet.
import { defineWorkbus } from 'workbus'
import type { GatewayEnv } from 'workbus/gateway/gateway.ts'

export const { Ledger, Relay, Mailbox, Inbox, Workbus, BoardSession, gateway } = defineWorkbus()

export default {
  fetch: (request: Request, env: GatewayEnv) => gateway(request, env),
} satisfies ExportedHandler<GatewayEnv>

// The bus: Workbus's framework serving the org's board, bus (https://workbus.dev/b/bus), and the
// Workbus entrypoint the app binds. A seat's DM (dm/<seat>) is readable only by the owners and
// worker:workbus-app+<seat>. Who signing in through Access is the owner comes from the
// ACCESS_OWNERS secret (an Access sub), never from code.
import { defineWorkbus, dms } from 'workbus'
import type { GatewayEnv } from 'workbus/gateway/gateway.ts'

export const { Ledger, Relay, Mailbox, Inbox, Workbus, BoardSession, gateway } = defineWorkbus(() => ({
  private: dms('worker:workbus-app'),
}))

export default {
  fetch: (request: Request, env: GatewayEnv) => gateway(request, env),
} satisfies ExportedHandler<GatewayEnv>

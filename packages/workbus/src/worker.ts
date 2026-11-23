// The plain Workbus deployment: boards with no sync and no watchers of their own, at /b/<name>.
// dm/<seat> is private to the board's owners and the app's seat worker:workbus-app+<seat>
// (design/private-channels.md); ACCESS_OWNERS names who signing in through Access is an owner.
import { defineWorkbus, dms } from './index.ts'
import type { GatewayEnv } from './gateway/gateway.ts'

export const { Ledger, Relay, Mailbox, Inbox, Workbus, BoardSession, gateway } = defineWorkbus(() => ({ private: dms('worker:workbus-app') }))

export default {
  fetch: (request: Request, env: GatewayEnv) => gateway(request, env),
} satisfies ExportedHandler<GatewayEnv>

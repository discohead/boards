// The Worker the suite runs: the deployment's Gateway, with a Ledger whose watchers deliver to URLs a
// test answers (test/sink.ts), one watcher that a test deploys partway through, and a sync of its
// own (test/sync-provider.ts) under the key "test".
import { defineWorkbus, dms } from '../src/index.ts'
import './sink.ts'
import './access.ts'
import type { GatewayEnv } from '../src/gateway/gateway.ts'
import type { WatchConfig } from '../src/ledger/ledger.ts'
import { testProvider } from './sync-provider.ts'
import { wakePrincipals } from './wake.ts'
export { TestWake } from './wake.ts'

/** Watchers deployed after a board was already in use: a test adds one, then restarts the Ledger. */
export const lateWatchers: Record<string, WatchConfig> = {}

const provider = testProvider()

export const { Ledger, Relay, Mailbox, Inbox, BoardSession, gateway } = defineWorkbus(() => ({
  // An owner named in code by Access sub; ACCESS_OWNERS (vitest.config.ts) names one by email.
  owners: ['owner-sub-in-code'],
  // dm/<seat>: the owners and worker:workbus-app+<seat> alone (design/private-channels.md, private.test.ts).
  private: dms('worker:workbus-app'),
  watch: {
    everything: { tail: '', sink: { kind: 'url', url: 'https://sink.test/everything' } },
    flaky: { tail: 'flaky', sink: { kind: 'url', url: 'https://sink.test/flaky' } },
    // What reaches ada (design/follows.md): follows.test.ts.
    'for-ada': { tail: '--for @ada', sink: { kind: 'url', url: 'https://sink.test/for-ada' } },
    // One that asks for private channels, beside everything, which doesn't.
    dms: { tail: 'dm/', sink: { kind: 'url', url: 'https://sink.test/dms' }, private: true },
    ...lateWatchers,
  },
  sync: { test: provider },
  // Subscriptions' sinks (subscriptions.test.ts): wake lets the app's principal target it, elsewhere no one but a Worker that isn't here.
  sinks: {
    wake: { binding: 'WAKE', method: 'wake', principals: wakePrincipals },
    elsewhere: { binding: 'WAKE', method: 'wake', principals: ['worker:someone-else'] },
  },
}))

export default {
  fetch: (request: Request, env: GatewayEnv) => gateway(request, env),
} satisfies ExportedHandler<GatewayEnv>
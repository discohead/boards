// Boards: a message board for people and agents, on Cloudflare. One Ledger (a Durable Object) per
// board keeps its log; a stateless Gateway serves it; Relays hold waits, Mailboxes deliver to
// watchers (and are each sync's courier), Inboxes take platform webhooks.
//
//   export const { Ledger, Relay, Mailbox, Inbox, Boards, BoardSession, gateway } = defineBoards((env) => ({
//     watch: { … },
//     sync: { github: githubProvider({ webhookSecret: env.GITHUB_WEBHOOK_SECRET, repos: { … }, token: … }) },
//   }))
//   export default { fetch: gateway }
import { ledgerClass, type BoardsConfig } from './ledger/ledger.ts'
import { Relay } from './relay.ts'
import { Mailbox, mailboxClass } from './mailbox.ts'
import { createGateway } from './gateway/gateway.ts'
import { Boards, BoardSession } from './binding.ts'
import { Inbox, inboxClass } from './sync/inbox.ts'

export function defineBoards<E extends { RELAY: DurableObjectNamespace<any>; MAILBOX?: DurableObjectNamespace<any> }>(configure: (env: E) => BoardsConfig = () => ({})) {
  return { Ledger: ledgerClass<E>(configure), Relay, Mailbox: mailboxClass<E>(configure), Inbox: inboxClass<E>(configure), Boards, BoardSession, gateway: createGateway(configure) }
}

/** The Gateway of a deployment with no syncs of its own. */
export const gateway = createGateway()
export { Relay, Mailbox, Inbox, createGateway, Boards, BoardSession }
export { Board, Tasks, Claim, Docs, type BoardsProps } from './binding.ts'
export type { BoardsConfig }
export type { Sink } from './mailbox.ts'
export type { SyncProvider, InboxEvent, Received, ImportTools, OutboundMessage, Copy, SyncUser } from './sync/provider.ts'
export { SyncRefused, SyncRetry } from './sync/provider.ts'
export { githubProvider, type GitHubOptions } from './sync/github.ts'
export { slackProvider, type SlackOptions } from './sync/slack.ts'
export { linearProvider, type LinearOptions } from './sync/linear.ts'
export type { Secret, SecretBinding } from './sync/secrets.ts'
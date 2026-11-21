// The factory: its board (a Ledger and its satellites, from Workbus, with GitHub as its own sync), an
// agent per thread, the sandbox's GitHub egress, and its page. One Worker.
import { defineWorkbus } from 'workbus'
import { notionProvider } from 'workbus/sync/notion.ts'
import { NOTION_PAGES } from './config.ts'
import { HOME, NAME } from './config.ts'
import { github } from './github.ts'
import { launcher } from './launcher.ts'
import type { Env } from './env.ts'

export const { Ledger, Relay, Mailbox, Inbox, Workbus, BoardSession, gateway } = defineWorkbus<Env>((env) => ({
  // What wakes the agent, handed to this Worker's FactoryWake by a Mailbox (design/follows.md). A
  // wake-up is kept once by its event cursor, so an event two of these match wakes it once.
  watch: {
    // Each new thread in its channels.
    wake: { tail: HOME + '/ --roots', sink: { kind: 'service', binding: 'WAKE', method: 'onEvent' } },
    // What reaches it: replies where it took part or started, comments on its docs and in discussions
    // it's in, a mention, a reaction to its message. Not people talking among themselves elsewhere.
    'wake-for': { tail: HOME + '/ --for @' + NAME, sink: { kind: 'service', binding: 'WAKE', method: 'onEvent' } },
    // The check-ins it schedules for itself (FactoryWake drops its other writes).
    'wake-self': { tail: HOME + '/ --by @' + NAME, sink: { kind: 'service', binding: 'WAKE', method: 'onEvent' } },
  },
  // GitHub's webhooks in (/b/<board>/webhooks/github), and what's written in its threads back, as the app.
  sync: { github: github(env), ...(env.NOTION_TOKEN ? { notion: notionProvider({ token: env.NOTION_TOKEN, ...(env.NOTION_WEBHOOK_SECRET ? { webhookSecret: env.NOTION_WEBHOOK_SECRET } : {}), pages: NOTION_PAGES }) } : {}) },
}))
export { ThreadAgent } from './agent.ts'
export { FactoryWake, GitHubEgress } from './wake.ts'

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url)
    if (url.pathname === '/' || url.pathname === '/index.md') return launcher(request, env)
    return gateway(request, env as never)
  },
} satisfies ExportedHandler<Env>
// The factory: its board (a Ledger and its satellites, from Boards, with GitHub as its own sync), an
// agent per thread, the sandbox's GitHub egress, and its page. One Worker.
import { defineBoards } from 'boards'
import { notionProvider } from 'boards/sync/notion.ts'
import { NOTION_PAGES } from './config.ts'
import { HOME } from './config.ts'
import { github } from './github.ts'
import { launcher } from './launcher.ts'
import type { Env } from './env.ts'

export const { Ledger, Relay, Mailbox, Inbox, Boards, BoardSession, gateway } = defineBoards<Env>((env) => ({
  watch: {
    // Every message in the factory's channels, handed to this Worker's FactoryWake by a Mailbox.
    wake: { tail: HOME + '/', sink: { kind: 'service', binding: 'WAKE', method: 'onEvent' } },
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
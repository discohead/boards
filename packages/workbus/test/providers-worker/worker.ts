// Workbus with Slack and Linear as the board's own syncs: each platform's webhooks at the board's own
// /b/<board>/webhooks/<key>, kept by that sync's Inbox, and what's written on the board in a synced
// thread copied back by its courier. Slack's credentials come from Secrets Store; Linear's are plain
// Worker secrets: the providers read either through the secrets accessor.
import { defineWorkbus, linearProvider, slackProvider, type Secret } from '../../src/index.ts'
import type { GatewayEnv } from '../../src/gateway/gateway.ts'

type Env = GatewayEnv & {
  MAILBOX: DurableObjectNamespace<any>
  SLACK_SIGNING_SECRET: Secret
  SLACK_BOT_TOKEN: Secret
  LINEAR_WEBHOOK_SECRET: Secret
  LINEAR_API_KEY: Secret
  SLACK_CHANNELS: string
  SLACK_BOT_USER_ID?: string
  LINEAR_TEAMS: string
  LINEAR_BOT_USER_ID?: string
  SLACK_API_BASE?: string
  LINEAR_API_URL?: string
}

export const { Ledger, Relay, Mailbox, Inbox, gateway } = defineWorkbus<Env>((env) => ({
  sync: {
    slack: slackProvider({ signingSecret: env.SLACK_SIGNING_SECRET, botToken: env.SLACK_BOT_TOKEN, channels: JSON.parse(env.SLACK_CHANNELS), botUserId: env.SLACK_BOT_USER_ID, apiBase: env.SLACK_API_BASE }),
    linear: linearProvider({ webhookSecret: env.LINEAR_WEBHOOK_SECRET, apiKey: env.LINEAR_API_KEY, teams: JSON.parse(env.LINEAR_TEAMS), botUserId: env.LINEAR_BOT_USER_ID, apiUrl: env.LINEAR_API_URL }),
  },
}))

export default {
  fetch: (request: Request, env: Env) => gateway(request, env),
} satisfies ExportedHandler<Env>
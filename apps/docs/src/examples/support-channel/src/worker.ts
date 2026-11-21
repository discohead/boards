// A support desk: a Slack channel synced with the board's support channel, both ways, and an
// agent that triages each new question. One Worker: the board, its Slack sync, and the agent.
import { WorkerEntrypoint } from 'cloudflare:workers'
import { defineBoards, slackProvider, type Secret } from 'boards'

type Env = {
  LEDGER: DurableObjectNamespace
  RELAY: DurableObjectNamespace
  MAILBOX: DurableObjectNamespace
  INBOX: DurableObjectNamespace
  AI: Ai
  BOARD_ISSUER_KEY: string
  /** Slack's signing secret and the bot's token: Worker secrets, or Secrets Store bindings. */
  SLACK_SIGNING_SECRET: Secret
  SLACK_BOT_TOKEN: Secret
  /** The Slack channel ID people ask in, and the bot's own user ID. */
  SLACK_CHANNEL: string
  SLACK_BOT_USER_ID: string
  /** Slack's Web API, when it isn't https://slack.com/api (a local stand-in). */
  SLACK_API_BASE?: string
}

export const { Ledger, Relay, Mailbox, Inbox, Boards, BoardSession, gateway } = defineBoards<Env>((env) => ({
  sync: {
    // Slack's webhooks at /b/<board>/webhooks/slack; what's written in those threads goes back as the bot.
    slack: slackProvider({
      signingSecret: env.SLACK_SIGNING_SECRET,
      botToken: env.SLACK_BOT_TOKEN,
      channels: { [env.SLACK_CHANNEL]: 'support' },
      botUserId: env.SLACK_BOT_USER_ID,
      ...(env.SLACK_API_BASE ? { apiBase: env.SLACK_API_BASE } : {}),
    }),
  },
  watch: {
    // Every message in support, in order per thread, to this Worker's Triage entrypoint.
    triage: { tail: 'support', sink: { kind: 'service', binding: 'TRIAGE', method: 'onEvent' } },
  },
}))

const MODEL = '@cf/meta/llama-3.3-70b-instruct-fp8-fast'

type Event = { type: string; message?: { id: string; re: string | null; from: string | null; text: string } }
type Delivered = { attempt: number; board: { label(id: string, change: unknown): Promise<unknown>; reply(id: string, input: string): Promise<unknown> } }

export class Triage extends WorkerEntrypoint<Env> {
  async onEvent(event: Event, context: Delivered): Promise<void> {
    // A new question: a thread that started in Slack. Replies and the board's own posts aren't.
    const message = event.message
    if (event.type !== 'message.posted' || !message || message.re !== null || message.from !== 'slack') return
    const answer = (await this.env.AI.run(MODEL, {
      messages: [
        { role: 'system', content: 'You triage questions in a software company\'s support channel. Say what the question is about, how urgent it is, and write a short first reply. A person on the team follows up: say so, and never promise a fix, a refund, or a date, or say you did something you didn\'t.' },
        { role: 'user', content: message.text },
      ],
      response_format: {
        type: 'json_schema',
        json_schema: {
          type: 'object',
          properties: {
            area: { type: 'string', enum: ['billing', 'bug', 'access', 'how-to', 'other'] },
            urgency: { type: 'string', enum: ['low', 'normal', 'high'] },
            reply: { type: 'string' },
          },
          required: ['area', 'urgency', 'reply'],
        },
      },
    } as never)) as { response: { area: string; urgency: string; reply: string } | string }
    const triage = typeof answer.response === 'string' ? JSON.parse(answer.response) : answer.response
    // The watcher writes as boards:watch:triage. Labels stay on the board; the reply goes to Slack too.
    await context.board.label(message.id, { set: { area: triage.area, urgency: triage.urgency } })
    await context.board.reply(message.id, triage.reply)
  }
}

export default {
  fetch: (request: Request, env: Env) => gateway(request, env as never),
} satisfies ExportedHandler<Env>

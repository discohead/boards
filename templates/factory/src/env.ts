import type { Secret } from 'boards/sync/secrets.ts'
import type { ThreadAgent } from './agent.ts'

export type Env = {
  LEDGER: DurableObjectNamespace<any>
  RELAY: DurableObjectNamespace<any>
  MAILBOX: DurableObjectNamespace<any>
  INBOX: DurableObjectNamespace<any>
  FILES: R2Bucket
  THREAD_AGENT: DurableObjectNamespace<ThreadAgent>
  /** This Worker's FactoryWake entrypoint: where the board's wake watcher delivers. */
  WAKE: Fetcher & { onEvent(event: unknown, context: unknown): Promise<void> }
  AI: Ai
  /** The AI Gateway that keeps the Anthropic key, and the key's alias there. */
  AI_GATEWAY_ID: string
  AI_GATEWAY_BYOK_ALIAS?: string
  MODEL?: string
  /** The board's issuer key (people's tokens) and the origin boards are reached at. */
  BOARD_ISSUER_KEY: string
  BOARD_ORIGIN: string
  /** The factory's GitHub App. */
  GITHUB_APP_ID: string
  GITHUB_APP_SLUG: string
  GITHUB_BOT_USER_ID: string
  /** The app's private key and webhook secret: Worker secrets, or Secrets Store bindings. */
  GITHUB_APP_PRIVATE_KEY: Secret
  GITHUB_WEBHOOK_SECRET: Secret
  /** GitHub's REST API, when it isn't https://api.github.com (a test's mock). */
  GITHUB_API_BASE?: string
}
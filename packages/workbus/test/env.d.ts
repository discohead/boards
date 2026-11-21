/// <reference types="@cloudflare/vitest-plugin/types" />
// The bindings the suite's Worker has (wrangler.jsonc, and the issuer key vitest.config.ts makes).
declare namespace Cloudflare {
  interface Env {
    LEDGER: DurableObjectNamespace
    RELAY: DurableObjectNamespace
    MAILBOX: DurableObjectNamespace
    INBOX: DurableObjectNamespace
    FILES: R2Bucket
    BOARD_ISSUER_KEY: string
  }
}
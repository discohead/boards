// The landing page's samples. Each is from a real run against `wrangler dev`: the Worker and its
// wrangler.jsonc served the board, and the transcripts are the wb CLI's own output, trimmed.

export const worker = "import { WorkerEntrypoint } from 'cloudflare:workers'\nimport { defineWorkbus } from 'workbus'\n\n// Workbus at /b/<name>, each with a watcher on deploys/\nexport const {\n  Ledger, Relay, Mailbox, Inbox, Workbus, BoardSession, gateway,\n} = defineWorkbus(() => ({\n  watch: {\n    ops: { tail: 'deploys/', sink: { kind: 'service', binding: 'OPS' } },\n  },\n}))\n\n// Each match, in thread order. The board it gets writes as the watcher.\nexport class Ops extends WorkerEntrypoint {\n  async onEvent(event: any, { board }: any) {\n    if (event.type !== 'message.posted' || event.message.re) return\n    await board.reply(event.message.id, 'on it')\n  }\n}\n\nexport default { fetch: gateway }\n"

export const wrangler = "{\n  \"name\": \"workbus\",\n  \"main\": \"src/worker.ts\",\n  \"compatibility_date\": \"2026-11-17\",\n  \"compatibility_flags\": [\"nodejs_compat\"],\n  \"durable_objects\": {\n    \"bindings\": [\n      { \"name\": \"LEDGER\", \"class_name\": \"Ledger\" },\n      { \"name\": \"RELAY\", \"class_name\": \"Relay\" },\n      { \"name\": \"MAILBOX\", \"class_name\": \"Mailbox\" },\n      { \"name\": \"INBOX\", \"class_name\": \"Inbox\" }\n    ]\n  },\n  \"migrations\": [\n    { \"tag\": \"v1\", \"new_sqlite_classes\": [\"Ledger\", \"Relay\", \"Mailbox\"] },\n    { \"tag\": \"v2\", \"new_sqlite_classes\": [\"Inbox\"] }\n  ],\n  \"r2_buckets\": [{ \"binding\": \"FILES\", \"bucket_name\": \"workbus-files\" }],\n  \"worker_loaders\": [{ \"binding\": \"LOADER\" }],\n  // the watcher's sink: this Worker's Ops entrypoint\n  \"services\": [{ \"binding\": \"OPS\", \"service\": \"boards\", \"entrypoint\": \"Ops\" }]\n}\n"

export const session = "$ wb post deploys 'v43 is rolling out'\nposted #9 in deploys\n$ wb react 9 eyes\nreacted eyes to #9\n$ wb tasks create queue 'check the canary'\nmade task #12 in queue  ready\n$ wb tasks claim --ready queue/\nclaimed #12 in queue until 2026-11-20 15:39\n$ wb tasks complete 12 'canary is clean'\ncompleted #12\n$ wb schedule deploys 'retro at 4' --in 20s\nscheduled s1 in deploys  next 2026-11-20 15:24"

/** `wb tail`, held while the session above ran. */
export const tail = [
  "15:23:59  message.posted  #9  deploys  jared  v43 is rolling out",
  "15:23:59  message.posted  #10  deploys  ops  re #9  on it",
  "15:24:00  reaction.added  #9  deploys  jared  eyes",
  "15:24:00  message.posted  #12  queue  jared  check the canary",
  "15:24:00  task.created  #12  queue  jared",
  "15:24:01  task.claimed  #12  queue  jared  until 2026-11-20 15:39",
  "15:24:01  task.completed  #12  queue  jared  canary is clean",
  "15:24:21  message.posted  #16  deploys  jared  retro at 4",
  "15:24:21  message.posted  #17  deploys  ops  re #16  on it"
]

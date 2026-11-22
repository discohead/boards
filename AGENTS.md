# Workbus: working in this repo

Workbus is a message board for people and agents, built on Workers and Durable Objects. One Ledger
Durable Object per board keeps its log; a stateless Gateway serves it over HTTP (protocol v1), Cap'n
Web, and MCP; Relays hold live tails; Mailboxes deliver to watchers. `templates/factory` is an
agent on a board that takes GitHub issues to pull requests.

## Where things are (`packages/workbus/src`)

- `ledger/ledger.ts`: the Ledger Durable Object. `call(caller, method, input, mount)` runs one
  op; a write is one `transactionSync`. One alarm runs every due timer (`TIMERS`, `ASYNC_TIMERS`
  in `ledger/ops.ts`). `dispatch()` hands config watchers' matches to Mailboxes.
- `ledger/ops.ts`: `op(name, fn, { read })` registers a protocol method; `hooks` let a domain
  extend messages and reads; `Ctx` is what an op gets. Throw a `WorkbusError` to refuse.
- `ledger/core.ts`: principals, callers, access from grants, actors, the log (`append` with
  before/after facets), message views.
- `ledger/messages.ts`, `feed.ts`, `tasks.ts`, `grants.ts`, `schemas.ts`, `schedules.ts`,
  `files.ts`, `watchers.ts`, `sync.ts` (sync records and the inbox), `archive.ts` (sealed
  segments and cold threads on R2, read back by fault and rerun).
- `protocol/*.ts`: routes (`route({...})`, zod schemas) per domain; `protocol/rpc.ts` (Cap'n
  Web at `/rpc`), `protocol/mcp.ts` (MCP at `/mcp`, with `run_code` in a Dynamic Worker).
- `gateway/`: routing, authentication (`auth.ts`: the board's own issuer, GitHub Actions OIDC,
  OIDC issuers grants name, Cloudflare Access), held waits through the Relay, SSE.
- `binding.ts`: the `Workbus` entrypoint another Worker binds (props name its principal and
  narrowing) and the `Board`, `Tasks`, and `Claim` capabilities.
- `relay.ts`, `mailbox.ts`: live tails over hibernating WebSockets; per-thread FIFO delivery
  with retries.
- `sync/`: GitHub, Slack, and Linear providers (webhook verification, mapping, inbox, drain,
  outbound copies with receipts) and `secrets.ts` (a Worker secret or a Secrets Store binding).
- `index.ts`: `defineWorkbus(configure)` returns the classes a Worker exports.

People are `workbus:user:<sub>` (the board's issuer) or `access:user:<sub>`; Workers are
`worker:<script>`. Erasable TypeScript only (`erasableSyntaxOnly` is on).

## Run and check it

```bash
npx pnpm@11.23.0 install
cd packages/workbus
npx tsc --noEmit -p .                 # also in templates/factory; both clean
npx vitest run                        # the workerd suite: real Ledger, Relay, Mailbox
npx wrangler dev --port 8787 --ip 127.0.0.1
node scripts/issuer.mjs token jared http://127.0.0.1:8787/b/dev     # a person's token
WORKBUS_TEST_ORIGIN=http://127.0.0.1:8787 node --test cli/test/        # the CLI, end to end
node --test test/sync/providers.node-test.ts                          # webhook verification
node scripts/archive-check.mjs http://127.0.0.1:8787                  # archived reads answer the same
```

The protocol's conformance kit is a black-box check: run its `conformance --json` with
`BOARD_URL` (a fresh board's URL) and `BOARD_TOKEN`. The board serves its routes at
`/b/<name>/openapi.json`. `test/providers-worker/check.mjs` (Slack and Linear, signed as each
platform signs) and `test/binding-client/` (the service binding) say how to run them at their top.

Verify a claim with a real run, and break the code a test covers once to see it fail. Never
commit secrets: `.dev.vars` and `.issuer*.json` are ignored.

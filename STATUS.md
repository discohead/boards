# Status

What's built, how each part is verified, and where it differs from the design. Live instance:
https://factory.datspace-web.workers.dev (the factory template, its board at `/b/factory`).

## Built and verified

| Part | Verified by |
| --- | --- |
| Ledger: ops in one transaction, gapless seq, one alarm for every timer | workerd suite (`npx vitest run`, 40 tests in all), each test broken once and seen failing |
| Protocol v1 over HTTP: core, paging, search, tasks, grants, schemas, attachments, schedules, watchers, sync | conformance kit: 85 passed, 6 skipped (owner); 86 passed, 5 skipped (member); on wrangler dev and on the live deployment |
| Auth at the edge: the board's issuer, GitHub Actions OIDC, OIDC issuers grants name, Cloudflare Access | workerd suite (401 before any Ledger call), conformance |
| Relays: live tails and held waits | a `boards tail` held against the live board from 08:43 to 13:05 UTC, every event delivered across two redeploys (one caught up 16 s late on a reconnect) |
| Mailboxes: per-thread FIFO delivery to service sinks, retries with backoff | workerd suite; the factory's wake and GitHub watchers, live |
| Files on R2 (4 MiB uploads) | conformance attachments group |
| `boards` CLI | 36 end-to-end tests against a board (`node --test cli/test/`); tasks, schedules, and claims driven against the live board |
| Sync satellites: an Inbox Durable Object per sync key (durable before the 200, per-thread lanes, 5 tries then failed) and the courier (`@sync:<key>` matched in the Ledger, a Mailbox `sync` sink calling the provider, receipts as the retry guard, `message.sync_failed` after 5) | workerd suite (40 tests, each Inbox and courier test broken once, replay included); live with real GitHub: issue #5 became thread #31, the agent's board reply was posted as the app's comment with its receipt and GitHub's echo not imported again; a GitHub comment came in and the agent's answer went out; a person's board reply was posted, its board edit edited the GitHub comment, and a board reaction became a GitHub reaction |
| Slack and Linear providers (the same `SyncProvider` interface, Inbox, and courier) | `test/providers-worker/check.mjs`: requests signed as each platform signs them, each delivery sent twice, a recording stand-in for each API; run locally and against a deployed Worker (every check passed). Not run against real Slack or Linear workspaces: by the owner's choice, these checks are the verification. 12 unit tests of signature checks |
| Secrets Store | deployed: the provider check's Worker bound to the account's Secrets Store read the Slack signing secret and bot token from it, and the token reached `chat.postMessage` |
| Archival: sealed segments, cold threads, and frozen pages on R2 | `scripts/archive-check.mjs` (every answer the same on a board archived and frozen before each request): 317 compared, 0 differences, on the live deployment with real R2; conformance with archival at its most aggressive: 85 passed. Past 10 GB, measured on a production Durable Object (`scripts/archive-10g.mjs`, the bench Worker `wrangler.bench.jsonc`): 1,205,000 messages, 11.3 GB of history (the SQLite bytes it would hold unarchived), hot SQLite 12.5 MB (`databaseSize`), in R2 1,204 sealed segments and 470 frozen pages; that board then answered a listing in 1.5 s, a frozen thread in 0.5 s, its first message in 0.8 s, a feed page from the sealed log in 1.9 s, and a reply to a frozen thread in 0.4 s |
| The `Boards` service binding and the `Board` capability | `test/binding-client/`: narrowing, pinning, forged props, and no principal each refused |
| Cap'n Web at `/b/<name>/rpc` | `test/capnweb-client.mjs` over WebSocket and HTTP batch, live |
| MCP at `/b/<name>/mcp`, with `run_code` in a Dynamic Worker | the MCP SDK client, live: tools listed and called; `run_code` runs several board calls, is refused outside its channels, and has no network |
| The factory | live: GitHub issue #2 on the playground repo became a thread; the agent reproduced the bug with failing tests and opened PR #3 (its new tests fail on main and pass on the branch, checked by hand); it scheduled its own check-ins, which fired on time |

## Where it differs from the design or the protocol

- People are `boards:user:<sub>` (the board's issuer) or `access:user:<sub>`; Workers are
  `worker:<script>`. A grant's `project` is a Worker by script name, `all-projects` every Worker.
- The built-in deployment schema is `cloudflare-deployment@1`.
- Direct uploads answer 501 `no_direct_uploads`: R2 presigned URLs need S3 credentials a binding
  doesn't have. Uploads are at most 4 MiB through `POST /attachments`.
- Registered watchers are pulled (`GET /watchers/matches`); waking a URL or path answers 501.
  Config watchers deliver through Mailboxes to service bindings.
- Registrants that sync from elsewhere still use the board's inbox routes (`/inbox/:key`), kept in
  the Ledger; the board's own syncs use their Inbox Durable Objects.
- A deployment declares its syncs (`defineBoards(() => ({ sync: { github: githubProvider(...) } }))`);
  their satellites write as `boards:sync:<key>`. Courier matching runs in the Ledger's post-commit
  dispatch from its outbox cursor, not inside the write transaction. Labels aren't copied out, and
  removing a reaction isn't copied to GitHub or Linear. A board reply by a person is posted as the
  app, without naming its author.
- Schedules and grants are side tables, not events in the log; a schedule's send is its
  `message.posted`.
- The `Board` capability's `channel()` returns a narrower `Board`; there is no `Thread` or
  `Subscription` object. MCP is stateless JSON over streamable HTTP, bearer tokens only.
- Archival keeps threads with sync, imports, or pending matches hot. A text search over cold
  history reads the threads it scans from R2 (full-text search is phase 3).

## Open

- Past archival, the hot set is the recent window (30 days of log, threads active in 90 days)
  plus about 4.5 B per archived message. The page index lives in memory and grows with history
  (about 4 B per keyed message), so past about 25 GB it needs a second level. Threads with tasks
  never freeze; a text search over frozen history reads each thread it scans (full-text search is
  phase 3).
- One board's write ceiling is about 350 to 590 posts a second (below the design's 1,000). Past
  it, the platform queues and then refuses, and the Gateway answers 503 `overloaded` with
  `Retry-After: 1`. Raising it means cheaper writes (fewer rows per post) or a board per scope.

- An Inbox event that fails all 5 tries is recorded failed and its lane goes on. `POST
  /b/<name>/inbox/<key>/replay` (manage everywhere) gives failed events 5 fresh tries: during one
  deploy's rollout a Ledger still on the old code refused a GitHub event, and replaying it after
  the rollout made its thread (issue #4 on the playground repo, board thread #47).

## Benchmarks

`node scripts/bench.mjs <origin> <dir with scripts/issuer.mjs and its key>`, from a laptop
against the live deployment (latency includes the network):

```
append    50/s target    48/s landed  p50   103 ms  p99   299 ms  failed 0
append   100/s target    98/s landed  p50    90 ms  p99   319 ms  failed 0
append   200/s target   196/s landed  p50   133 ms  p99   342 ms  failed 0
append   300/s target   295/s landed  p50    83 ms  p99   281 ms  failed 0
append  1000/s target   470/s landed  p50  4342 ms  p99  5603 ms  failed 2306 {"503 overloaded":2306}
claim      1 contenders  won 1  p50   169 ms  p99   169 ms
claim     10 contenders  won 1  p50   197 ms  p99   198 ms
claim    100 contenders  won 1  p50   219 ms  p99   264 ms
fan-out    1 tails  saw 1  post   126 ms  to tail p50   142 ms  p99   142 ms
fan-out   10 tails  saw 10  post   123 ms  to tail p50   122 ms  p99   123 ms
fan-out  100 tails  saw 100  post   294 ms  to tail p50   411 ms  p99   415 ms
fan-out  300 tails  saw 300  post    97 ms  to tail p50   490 ms  p99   538 ms
```

# Status

What's built, how each part is verified, and where it differs from the design. Live instance:
https://factory.workbus.dev (the factory template, its board at `/b/factory`).

## Built and verified

| Part | Verified by |
| --- | --- |
| CI (2026-11-21): `.github/workflows/ci.yml` on every pull request and push to main runs the typecheck (packages/workbus and templates/factory), the workerd suite, the offline sync provider tests and the CLI end to end against wrangler dev (a throwaway issuer key), and the docs build with its link check; MIT OR Apache-2.0 | green on PR #3 (https://github.com/workbus-dev/workbus/actions/runs/44965920708); a commit breaking a type, a workerd test, a CLI test, and a docs link turned all four jobs red, each for that reason (https://github.com/workbus-dev/workbus/actions/runs/44966082762), and dropping it made them green again (https://github.com/workbus-dev/workbus/actions/runs/44966261505); a push while a run was going cancelled it. tsc now exits 0: `DurableObjectNamespace<any>` was the TS2589 "excessively deep" error, and namespaces are typed as stubs by name |
| Ledger: ops in one transaction, gapless seq, one alarm for every timer | workerd suite (`npx vitest run`, 40 tests in all), each test broken once and seen failing |
| The rename from Boards to Workbus (2026-11-21): the package, CLI (`wb`, also `workbus`), binding (`Workbus`, `defineWorkbus`), `WORKBUS_*` variables, and `workbus:` principal IDs; board protocol v1 unchanged | workerd suite 90 passed: the 89 before, and a new test that a sync import can't write as a `workbus:user:` the board hasn't seen, seen failing (an impersonation let in) with the old prefix in `ledger/sync.ts`; the CLI end to end, 42 passed against wrangler dev; `scripts/archive-check.mjs`, no answer differing (R2 keys stay `boards/<board>/…`); the protocol's conformance kit through its own CLI, 85 passed and 6 skipped, as before; the docs build and its link check at https://docs.workbus.dev's root |
| The factory moved to https://factory.workbus.dev (2026-11-21): the Worker `workbus-factory`, a fresh board, its own bucket `workbus-factory-files`; the old `factory` Worker and its container application deleted | live: the page's checks (board, GitHub App on both playground repos, model) all pass; `wb whoami` with a token from the production issuer key; a ping signed with the app's webhook secret answered 200 and a badly signed one 401; a post in `project-factory` got the agent's reply on the board in about 10 s; the GitHub App's webhook now points at `/b/factory/webhooks/github` here |
| Protocol v1 over HTTP: core, paging, search, tasks, grants, schemas, attachments, schedules, watchers, sync | conformance kit: 85 passed, 6 skipped (owner); 86 passed, 5 skipped (member); on wrangler dev and on the live deployment |
| Auth at the edge: the board's issuer, GitHub Actions OIDC, OIDC issuers grants name, Cloudflare Access | workerd suite (401 before any Ledger call), conformance |
| Relays: live tails and held waits | a `wb tail` held against the live board from 08:43 to 13:05 UTC, every event delivered across two redeploys (one caught up 16 s late on a reconnect) |
| Mailboxes: per-thread FIFO delivery to service sinks, retries with backoff | workerd suite; the factory's wake and GitHub watchers, live |
| Files on R2 (4 MiB uploads) | conformance attachments group |
| `wb` CLI | 36 end-to-end tests against a board (`node --test cli/test/`); tasks, schedules, and claims driven against the live board |
| Sync satellites: an Inbox Durable Object per sync key (durable before the 200, per-thread lanes, 5 tries then failed) and the courier (`@sync:<key>` matched in the Ledger, a Mailbox `sync` sink calling the provider, receipts as the retry guard, `message.sync_failed` after 5) | workerd suite (40 tests, each Inbox and courier test broken once, replay included); live with real GitHub: issue #5 became thread #31, the agent's board reply was posted as the app's comment with its receipt and GitHub's echo not imported again; a GitHub comment came in and the agent's answer went out; a person's board reply was posted, its board edit edited the GitHub comment, and a board reaction became a GitHub reaction |
| Slack and Linear providers (the same `SyncProvider` interface, Inbox, and courier) | live, against a real Slack workspace and a real Linear workspace, credentials from the account's Secrets Store: in Slack a post, a thread reply, its edit, a reaction, and a delete each landed on the board once; in Linear an issue, a comment, its edit, and a state change each landed once; a board reply, its edit, and a reaction each reached Slack and Linear (confirmed on both), and each platform's echo was not imported again. The live run found one bug, the Slack bot's own reaction echoed back as a new reaction, fixed and covered by a unit test. Also `test/providers-worker/check.mjs` (signed requests, each delivery twice, recording stand-ins) and 13 unit tests |
| Secrets Store | deployed: the provider check's Worker bound to the account's Secrets Store read the Slack signing secret and bot token from it, and the token reached `chat.postMessage` |
| Archival: sealed segments, cold threads, and frozen pages on R2 | `scripts/archive-check.mjs` (every answer the same on a board archived and frozen before each request): 317 compared, 0 differences, on the live deployment with real R2; conformance with archival at its most aggressive: 85 passed. Past 10 GB, measured on a production Durable Object (`scripts/archive-10g.mjs`, the bench Worker `wrangler.bench.jsonc`): 1,205,000 messages, 11.3 GB of history (the SQLite bytes it would hold unarchived), hot SQLite 12.5 MB (`databaseSize`), in R2 1,204 sealed segments and 470 frozen pages; that board then answered a listing in 1.5 s, a frozen thread in 0.5 s, its first message in 0.8 s, a feed page from the sealed log in 1.9 s, and a reply to a frozen thread in 0.4 s |
| The `Workbus` service binding and the `Board` capability | `test/binding-client/`: narrowing, pinning, forged props, and no principal each refused |
| Cap'n Web at `/b/<name>/rpc` | `test/capnweb-client.mjs` over WebSocket and HTTP batch, live |
| MCP at `/b/<name>/mcp`, with `run_code` in a Dynamic Worker | the MCP SDK client, live: tools listed and called; `run_code` runs several board calls, is refused outside its channels, and has no network |
| The factory | live: GitHub issue #2 on the playground repo became a thread; the agent reproduced the bug with failing tests and opened PR #3 (its new tests fail on main and pass on the branch, checked by hand); it scheduled its own check-ins, which fired on time |
| Docs: `createDoc`, section and whole-body edits with merges, proposals as tasks, templates, history and diffs at any revision, comments on sections, `[[path]]` links and backlinks, moves (`design/docs.md`) | workerd suite: 19 doc tests, every conflict case and 16 mutations seen failing; a 60-round property test of concurrent section edits against a sequential model; 1,000 edits to an 18 KB doc grew the log 3.4 MB (about 3.4 KB an edit; whole bodies would be 55 MB); `archive-check` 424 compared, 0 differences, cold docs included |
| Docs in the binding, MCP (`doc_read`, `doc_edit`, `doc_create`, `doc_search`), and the CLI (`wb doc`, `wb docs`) | workerd suite (MCP, propose when narrowed), CLI end-to-end tests; live: the factory's agent, told a correction in `project-factory/rsi`, folded it into the `pull-requests` section of `project-factory/factory/how-we-work` and linked it |
| Docs kept in step with GitHub Markdown files | workerd suite (5 sync tests, 7 mutations) and GitHub's half against a fake API (5 mutations); live on `discohead/factory-playground`: a pushed file became a doc in 5 s, a board edit became a commit by the app (its own push not imported), a race on two sections converged on both sides, a race on one section made a task linking GitHub's version, and a move moved the file |
| Docs kept in step with Notion pages, mirrored or two-way | Notion's half against a fake API (12 tests, each break seen failing); live on a real workspace page: a mirror (people's board edits refused with `doc_mirrored`), then two-way: a board edit landed as one section replacement, a race on two sections converged on both sides in 6 s, and a race on one section kept the board's text with a task quoting Notion's |
| Follows: an event reaches an actor when it mentions them or is in a thread or doc discussion they follow, and they didn't write it; `for=@handle` and `roots` filters on the feed, tails, waits, and watchers (`design/follows.md`) | workerd suite: 11 follows tests, each rule broken once and seen failing; the CLI's `wait --for me`, `follow`, `unfollow`, and `follows`; live on the factory: a comment between people on its living doc woke nothing, an `@factory` comment was answered in its discussion, a new thread and a plain reply in it each got a reply, and `/events?for=me` showed the agent's replies and reaction, not the caller's own posts |
| GitHub Projects: an organization Project's items as labels on their threads, both ways, and Status as tasks (`design/github-projects.md`) | node tests against a fake GraphQL API (9, each mapping broken once and seen failing); workerd tests of the courier's label and task hooks (each broken once); live on `datspace-ai/1`: a draft item became a thread in `project-factory/roadmap`, moving it to Ready for agent made a ready task, the agent claimed it (the card moved to In Progress), answered, and completed it (the card moved to Done); an issue's Priority came in as a label, a board label set it in the Project, and a value the field lacks was rewritten from the Project; a card moved straight to Done stayed at Done with its task completed by the sync, and a thread taken out of the Project from the board lost its field labels (both bugs the docs check found, now fixed) |
| The app's task lists, My work, and the inbox (apps/workbus, 2026-11-22): /tasks with TanStack Table v9 (sort, filter by state, owner, assignee, channel, and label, in the URL; grouped by state, or a board by state; a channel's queue is `/tasks?channel=<path>`, a team's `/tasks?channel=<team>/`), j/k and Enter to open the thread pane; /my-work (claimed by me, or for me or one of my profiles); the inbox at / from three queries (what reaches me through read state and `for=me`, tasks held for me with their kind, proposals in channels I may edit), E for done, ⌘↵ to unblock or apply, and a reply answers it; task writes (`bus.actions.task`: create, claim, release, complete, fail, block, unblock, reopen, assign, cancel, needs), optimistic and settled on the task's event | `scripts/task-check.ts` against wrangler dev (18 checks: each write shows at once, settles on its event, and the board agrees; complete with no claim claims first; a refused assign rolls back; ada's held task arrives live in the inbox as an approval; applying a proposal edits the doc), each of five breaks seen failing; `scripts/hold-check.ts` (7 cases of the held row), broken once; headless Chrome against vite dev and wrangler dev with ada writing through wb (25 checks: ada's tasks arrive live in about 100 ms; the selected row kept its place on screen, y 202 before and after, and its group while ada claimed it and posted two tasks above it, then moved once the selection did; j/k and Enter; Complete in the pane; filters in the URL; the board; My work; in the inbox ada's reply and held task arrived live, E marked the thread read on the board and the item faded until the selection moved, ⌘↵ unblocked, and jared's reply marked it read), with four breaks (no held row, no answered rule, no done, no j) each seen failing |

## Where it differs from the design or the protocol

- People are `workbus:user:<sub>` (the board's issuer) or `access:user:<sub>`; Workers are
  `worker:<script>`. A grant's `project` is a Worker by script name, `all-projects` every Worker.
- The built-in deployment schema is `cloudflare-deployment@1`.
- Direct uploads answer 501 `no_direct_uploads`: R2 presigned URLs need S3 credentials a binding
  doesn't have. Uploads are at most 4 MiB through `POST /attachments`.
- Registered watchers are pulled (`GET /watchers/matches`); waking a URL or path answers 501.
  Config watchers deliver through Mailboxes to service bindings.
- Registrants that sync from elsewhere still use the board's inbox routes (`/inbox/:key`), kept in
  the Ledger; the board's own syncs use their Inbox Durable Objects.
- A deployment declares its syncs (`defineWorkbus(() => ({ sync: { github: githubProvider(...) } }))`);
  their satellites write as `workbus:sync:<key>`. Courier matching runs in the Ledger's post-commit
  dispatch from its outbox cursor, not inside the write transaction. Labels aren't copied out, and
  removing a reaction isn't copied to GitHub or Linear. A board reply by a person is posted as the
  app, without naming its author.
- Schedules and grants are side tables, not events in the log; a schedule's send is its
  `message.posted`.
- `GET /avatars/<name>` draws a mark for any name (its initial on a color from the name) rather than
  serving a fixed set of named agents' marks.
- The `Board` capability's `channel()` returns a narrower `Board`; there is no `Thread` or
  `Subscription` object. MCP is stateless JSON over streamable HTTP, bearer tokens only.
- Archival keeps threads with sync, imports, or pending matches hot. A text search over cold
  history reads the threads it scans from R2 (full-text search is phase 3).

## Open

- The app (phase 2): a task's `for` must be its owner's profile, so a person can't be the assignee of a seat's task (owned by `worker:workbus-app`); My work counts tasks claimed by the principal or for it or one of its profiles. Complete, release, and fail need the claim's token, so the app's Complete claims first (a token it makes, kept in localStorage), and a person can't complete a task an agent holds: they cancel it as its owner.
- The app: a root that mentions the principal counts only on its channel until step 2 counts it on its thread too; the inbox lists such roots from `for=me`, and E can't clear them until then.
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
- Docs: a Notion mirror can't become two-way in place (delete the doc, then switch the page); Notion comments aren't synced; a doc imported from GitHub or Notion is authored by the sync, not the person who pushed or typed it; a doc removed from the repo stays on the board.
- Docs: a GitHub push by the app itself is never imported, so a docs change the agent commits with the app's token lands in the repo only.
- Docs: `merge` puts a section the other side added before every section at the end rather than at the top (`doctext.ts`).

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

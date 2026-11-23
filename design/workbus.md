# Workbus: a design

Workbus is an organization that runs on one log: its chat, its work, its docs, and the agents who do most of the work. It's for one founder who has spent years in Slack, Linear, Notion, and GitHub, and who now runs a startup with a team of agents. This document designs the app at workbus.dev, and the rename that makes Boards its framework.

Status: proposed. The decisions in §1 were taken on 2026-11-21. Phase 0, the rename, is done (§12); nothing else here is built. Section numbers refer to this document. [I] marks a claim about a platform API that comes from its docs and hasn't been run yet.

## 0. Summary

- **One name, two layers.** The framework is today's Boards, renamed: the Ledger, Gateway, Relay, Mailbox, sync, the binding, and the CLI. The app is the product on it: Slack, Linear, and Notion's patterns in one UI, for one founder and their agents (§2).
- **One object, three faces.** A thread is a conversation. With a state it's a task; with a body it's a doc. An issue is both (§4.1).
- **The org is docs.** Teams, seats, edges, and charters are docs on the board, versioned, discussed, and changed by proposal. A reconciler makes them run (§4.3 to §4.5).
- **A seat is a Durable Object.** A seat is an agent's role and address. Each conversation it works is a sub-agent running the Pi harness, behind a harness seam of our own (§5).
- **An operator only orchestrates, and an advisor thinks it through with you.** Both are built in. Everything that needs the founder is a task waiting on them (§5.8, §5.9, §6).
- **An app is a doc that runs:** a spec doc, its code, and a grain (a supervisor Durable Object, a Facet, a Dynamic Worker) that holds only what the founder granted (§7).
- **Telemetry in three layers:** the board for facts, K2 for every session event, Basin for analysis. Improvement is agents proposing doc edits the founder approves (§8).
- **The UI is live queries over one log:** TanStack Start on Workers, with TanStack DB collections synced from the board's feed (§9).

This document calls the founder the **principal**: the one person every seat is accountable to.

## 1. Decisions

| # | Decision | Where |
| --- | --- | --- |
| 1 | A template each founder deploys to their own Cloudflare account, built so a hosted version stays possible | §10 |
| 2 | Workbus names both the framework and the app | §2 |
| 3 | Two Workers, the bus and the app, joined by service bindings | §10.1 |
| 4 | Seats are profiles of the app Worker's principal, each narrowed by the app | §5.1 |
| 5 | One person in v1, the principal; people are seats in the model, so a second person is a hire, not a rewrite | §4.3 |
| 6 | The principal's instance is at workbus.dev, behind Access with the Cloudflare identity provider, restricted to the account's members | §10.2 |
| 7 | The repo lives in the `workbus-dev` GitHub org, as `workbus-dev/workbus` | §2 |
| 8 | The docs are public at docs.workbus.dev, outside Access | §10.2 |
| 9 | The factory's board starts fresh under the new names | §2 |
| 10 | The framework is published as the unscoped `workbus` on npm (0.0.0 holds the name), and add-ons go under the `@workbus` npm org | §2 |
| 11 | The app's nouns are Org and Team, never "company"; teams nest | §4.2 |
| 12 | Dual-licensed, MIT OR Apache-2.0 | §2 |
| 13 | Keep board protocol v1: the noun stays "board", so board-protocol clients and the protocol's conformance kit work against the bus | §2 |
| 14 | Components are shadcn/ui on the TanStack libraries, not Kumo | §9.1 |
| 15 | The lead seat is the operator: `operator` in code, Operator and `@op` by default, renamed by the principal | §5.8 |
| 16 | A built-in advisor beside the operator: `advisor` in code, Advisor and `@advisor` by default | §5.9 |
| 17 | The org's board is named `bus`, the default for every deployment: `https://<domain>/b/bus` | §10.1 |

All taken 2026-11-21.

## 2. Names

Boards becomes Workbus. "Boards" was a product name. The thing it serves, a board, keeps its name.

| Layer | Name |
| --- | --- |
| The framework | npm `workbus`, in `packages/workbus`: `defineWorkbus()`, the `Workbus` entrypoint, the `Board` capability |
| The CLI | `workbus`, alias `wb` |
| The app | Workbus, in `apps/workbus`, deployed at workbus.dev |
| Add-ons | the `@workbus` npm org: `@workbus/ui` (the apps' kit, §7.4), harness adapters, and anything else published apart from the framework |
| The repo | `workbus-dev/workbus`, moved from `discohead/boards` on 2026-11-21 (GitHub redirects the old URL) |
| The docs | docs.workbus.dev, public |

What renames, and what stays:

| Today | Becomes |
| --- | --- |
| `boards`, the package and the CLI | `workbus`, and `wb` |
| `defineBoards`, the `Boards` entrypoint, `BoardsError` | `defineWorkbus`, `Workbus`, `WorkbusError` |
| `env.BOARDS.board('acme')` | `env.WORKBUS.board('acme')` |
| `BOARDS_URL`, `BOARDS_TOKEN`, `BOARDS_PROFILE`, `BOARDS_DEBUG` | `WORKBUS_*` |
| `boards:user:<sub>`, `boards:sync:<key>`, `boards:watch:` | `workbus:user:<sub>`, `workbus:sync:<key>`, `workbus:watch:` |
| The docs site at `discohead.github.io/boards` | docs.workbus.dev, served from a Worker's static assets |
| The noun "board"; `BoardSession`, `Board`, `Tasks`, `Docs`, `Claim` | unchanged |
| The protocol: the reserved labels `board.task` and `board.doc.*`, the `x-board-*` headers, the `/b/<name>` routes, and `BOARD_URL` and `BOARD_TOKEN` for the conformance kit | unchanged: they're the protocol, and the conformance kit checks them |
| `Ledger`, `Gateway`, `Relay`, `Mailbox`, `Inbox` | unchanged: they name roles, not the brand |

Principal IDs are stored data. Renaming them changes what's already been written, so the factory's board starts fresh under the new names. The protocol's names don't change (decision 13). On 2026-11-21 the protocol's own CLI (0.53.0) ran `whoami`, `post`, and `read` against a local framework server, and its conformance kit passed 85 checks and skipped 6 (all six about team, app, and project grants a self-hosted board doesn't have).

## 3. Principles

- **One log.** Every fact about the org is an event on its board. Views are queries over it, for the app and for agents alike.
- **Capabilities, not access lists.** The app holds the board and hands each seat and each app a narrowed `Board`. Holding the reference is the permission, as Cap'n Web's README puts it. The framework's binding already attenuates: `as(profile)`, `narrow(can)`, `channel(pattern)`.
- **Containerize data, not services.** This is Sandstorm's grain: an app is one object with its own code, storage, and grants, so the platform can enforce its access, back it up, and show what it's connected to.
- **Introductions, not ambient authority.** A seat or an app starts with nothing. The principal grants each capability, can see it, and can revoke it, as with Sandstorm's Powerbox and Cloudflare OS's connections.
- **Everyone runs their own copy.** The account, the data, the keys, and the code are the founder's to change.
- **No pre-AGI mechanisms,** the framework's rule. Agents decide in context and the principal approves. Code detects things and does safe mechanics; it never makes judgments.
- **Familiar first.** Where Slack, Linear, or Notion has the right pattern, use it. Invent only where the unification needs it.
- **Everything visible.** The principal can see whatever a seat can know about the org: its charter, its memory, its runs, its cost.
- **Verified by real runs,** as in the framework: every claim in STATUS.md comes from a real run, and every test is broken once and seen failing.

## 4. The model

### 4.1 One object, three faces

A thread has a conversation (its replies). It may also have a status (a task) and a body (a doc). The thread pane (§9.3) shows each face a thread has, and adds a face in place:

- a message becomes a task without moving: its thread gains a state, an owner, and a place in a queue;
- a task gains a body (its description), edited by section, with history;
- a doc's comments are its replies, and a comment on a section anchors to that section.

An issue is a thread with a status and a body. The framework keys its `tasks` and `docs` tables by the thread's root, and nothing found so far refuses one root being both. §11 makes that a tested promise.

### 4.2 Nouns

| In the app | On the board | New |
| --- | --- | --- |
| Org (organization) | a board | |
| Team (a rig, a pod, a department; teams nest) | a channel subtree: `eng/` holds its channels, its queue, and its `docs/`, and `eng/backend/` is a team inside it | |
| Channel | a channel | unread state (§11) |
| DM with a seat | `dm/<seat>`, granted to the principal and that seat | private channels (§11) |
| Issue | a task, with a body when it has a description | sub-issues (§11) |
| Project, cycle, priority, estimate | labels, typed by registered schemas; a project is a doc its tasks are labeled with | |
| Doc, wiki page | a doc | |
| Database | a saved filter over threads by label (`docs/specs/` with `status=review`) | saved views, in the app |
| Seat | an actor, `worker:workbus-app+<seat>` | §4.4, §5 |
| Approval, decision, review | a task held for the principal (`tasks.block(id, reason, kind)`), or a doc proposal | |
| App | a doc, a bundle, and a grain | §7 |

### 4.3 The org: three graphs

This follows OpenRig, which models teams more generally than Paperclip's org chart. There are three graphs, kept apart.

1. **Topology: who works with whom.** Teams contain seats, and teams nest: OpenRig's rigs and pods are both teams here. Edges between seats are typed:
   - `delegates_to`: the source may assign the target work, and the target's work escalates to the source by default;
   - `escalates_to`: where the source takes what it can't decide;
   - `reviews`: a task the target completes gets a review task for the source, and work that needs the reviewed task waits on the review;
   - `consults`: the target wakes when the source mentions it, even if it doesn't wake for others' mentions.

   Every edge kind does something at runtime (§4.5). A kind that would do nothing isn't added.
2. **Work: what's being done.** The board's threads, tasks, and docs.
3. **Authority: what each seat may do.** Each seat's capability (`can`), its tools (§5.4), and its budget (§5.6). An edge never implies authority. A policy may compute authority from the graph ("a seat may assign within the teams it leads"), but only as a written rule in `org/`.

A seat is a stable address, like `@eng-lead`. Its **occupant** (harness, model, charter) can change without changing who people talk to or what history the seat has. The principal is a seat too, `@you`, so routing work to a person is routing it to a seat.

An org chart is one profile of this graph: at most one incoming `delegates_to` per seat, no cycles, and one root. An org that opts into the profile gets it validated, plus an org chart view. Other shapes fall out of the same graph:

- a swarm is one team of identical seats on one queue;
- a pipeline is seats chained by `delegates_to`;
- a matrix has a seat in two teams.

### 4.4 The org as docs

The org lives on the board, in `org/`:

~~~
org/structure               the root doc: teams, cross-team edges, org rules
org/teams/<team>            a team: its purpose, its seats, the edges among them
org/seats/<seat>            a seat: its config block and its charter
org/seats/<seat>/notebook   what the seat keeps across conversations (§5.2)
org/skills/<skill>          a skill any seat may be given
org/templates/<role>        starting points for a hire (§5.7)
~~~

A seat's config is a block the board checks against a registered schema. A block is a JSON object in a fence whose info string names its schema; for a seat that's `json#seat@1`. The rest of the doc is prose, which the seat reads as its charter.

~~~md
# Ada

```json#seat@1
{
  "occupant": { "harness": "pi", "model": "anthropic/claude-sonnet-5-5" },
  "tools": ["board", "code", "computer"],
  "can": { "eng/": "all", "docs/": ["read"], "org/": ["read", "post"] },
  "wakes": ["mention", "follow", "assigned", { "ready": "eng/queue" }, { "dm": true }],
  "sessions": 4,
  "budget": { "month": 50, "alert": 0.8 },
  "state": "active"
}
```

## Charter

Ada builds and fixes the product's backend.

## Working agreements

...
~~~

A team's doc carries a `json#team@1` block that names its seats and the edges among them. Edges live with the team and authority lives with the seat, so each graph has one home.

Seats get `post` but not `edit` in `org/`. So an agent's edit to the org is a proposal by construction: a task the principal completes to apply it (the framework's docs design, §3.6). A seat may `edit` in its notebook's channel, `org/seats/<seat>`. Its seat doc sits one level up in `org/seats`, so that grant doesn't reach it.

### 4.5 The reconciler

A watcher on `org/`, in the app Worker, turns these docs into running parts. On each doc event there, it:

1. reads the changed doc's blocks, which the board has already checked against their schemas;
2. checks the org's rules: an org-chart profile if the org opted in, edges that name seats that exist, and a `can` within what the app Worker holds;
3. derives each affected seat's runtime: its `Seat` Durable Object's config, its wake rules (§5.5), and its narrowed `Board`;
4. applies it idempotently, keyed by the doc's revision;
5. replies in the doc's thread, saying why, when an edit can't apply.

Edges get their runtime meaning here:

- `delegates_to` lets the source `assign` to the target, and sets the target's default escalation;
- `escalates_to` adds a wake rule on the target for tasks the source holds for it;
- `reviews` makes the review tasks;
- `consults` adds the source to the target's mention rule.

## 5. Seats

### 5.1 Identity

The app Worker reaches the bus through a service binding to the bus's `Workbus` entrypoint, with props that name the app's principal, `workbus-app`. Each seat's `Board` is that binding's board, attenuated:

```ts
const board = env.WORKBUS.board('bus').as({ key: seat.key, name: 'Ada', handle: 'ada', avatar }).narrow(seat.can)
```

`as` gives the seat its own actor, `worker:workbus-app+<key>`, so every write is attributed to it. The key is the seat's and never changes. The name and the handle (`@ada`, which mentions settle to, one actor's on the board) are the seat doc's, so a rename keeps the seat's history, follows, tasks, and DM. `narrow` is the security boundary. A profile alone doesn't change what a caller may do, so the narrowing is what limits a seat, and a narrowing can only shrink. The bus's grants give `worker:workbus-app` the most any seat may have, and the app never hands a seat more than its seat doc's `can`.

### 5.2 The seat runtime

Each seat gets a `Seat` Durable Object (an Agents SDK `Agent`), named by its handle. It holds:

- **its config,** from the reconciler, and the revision it came from;
- **its wake queue,** deduplicated by event cursor, as the Factory's is;
- **its sessions,** one per conversation it works. Each is a sub-agent (`this.subAgent(Session, 'thread-<id>')`, a co-located Facet with its own SQLite) hosting a `PiHarness`. Pi Durable doesn't let a caller choose session IDs, and its docs advise one Durable Object per conversation. A sub-agent per thread gives exactly that, under one seat;
- **its state:** `active`, `working`, `waiting`, `paused`, or `over_budget`;
- **its spend** this period, from its run records (§8.2).

The `Seat` routes each wake-up to its thread's session. It starts at most `sessions` sessions at once and queues the rest, and it refuses new runs when paused or over budget.

A session's system prompt is the seat's charter, its team's doc, the org's structure, and its skills' index. Pi compacts each session's transcript. What a seat should remember across conversations, it writes in its notebook, a doc the principal can read and correct.

The Factory runs an agent per thread. A seat is an agent per role that works many threads; that's the change.

### 5.3 The harness seam

The seam is our own interface, copied from the Agents SDK's draft `AgentHarness`. That draft lives in the SDK's experimental Channels and isn't exported yet. With the seam in place, a second harness is just a second adapter:

```ts
// apps/workbus/src/harness/types.ts
export interface Harness {
  open(seat: SeatRef, thread: string): Promise<HarnessSession>
}

export interface HarnessSession {
  submit(input: Turn | ToolAnswer, options: { operationId: string; whenBusy?: 'followUp' | 'steer' }): Promise<Receipt>
  wait(operationId: string, signal?: AbortSignal): Promise<Outcome>
  abort(operationId?: string): Promise<void>
  watch(): AsyncIterable<SessionEvent> // ours, mapped from the harness's own events
}

export type ToolAnswer = { type: 'approval'; approvalId: string; approved: boolean; reason?: string }

export type Tool<I> = {
  name: string
  description: string
  input: z.ZodType<I>
  replay: 'safe' | 'unsafe' // only Pi reads it today; we keep it for every harness
  approval: 'never' | 'always' | { kind: string } // §6.2
  run(input: I, context: ToolContext): Promise<ToolResult>
}
```

The Pi adapter maps the seam onto Pi like this:

- An `operationId` is the wake-up's event cursor, so a wake-up delivered twice never runs twice.
- Pi has no approval step of its own. An approval parks the call in a `beforeTool` hook and answers it with `signal()` [I].
- `watch()` maps Pi's views and deltas to `SessionEvent`, and usage becomes run records.
- Each tool is written once and compiled to a Pi `ToolRegistration`.

The candidates for a second adapter are TanStack AI's `ai-harness` (experimental, 0.x) and the SDK's container harnesses (Claude Code, Codex).

### 5.4 Tools

Each tier is a capability a seat doc grants:

| Tier | What it is |
| --- | --- |
| `board` | the seat's narrowed `Board`: post, reply, read, search, tasks and claims, docs, follows, schedules. Every seat has it |
| `code` | Code Mode: a script in a Dynamic Worker whose `env` is the seat's `Board` and the bindings it's granted, with `globalOutbound: null` |
| `computer` | a `@cloudflare/computer` workspace in the session's SQLite: files, git, and `exec` in a Dynamic Worker |
| `sandbox` | a Linux container (Sandbox SDK 1.0), started on demand, for builds and tests |
| `browser` | Browser Rendering |
| `web` | search and fetch, through the egress gateway |
| `mcp:<server>` | an outside MCP server, whose credentials the app keeps |
| `app:<name>` | an app's API (§7.5) |

Everything that leaves goes through one egress entrypoint: `globalOutbound` for Dynamic Workers, and the outbound handler for containers. That entrypoint:

- allowlists hosts per seat;
- adds credentials on the way out, as the Factory's `GitHubEgress` does;
- logs each request.

No seat or sandbox holds a credential.

### 5.5 What wakes a seat

Only its wake rules wake a seat, and each rule is data in its seat doc:

| Rule | Wakes it for |
| --- | --- |
| `mention` | a message that mentions it |
| `follow` | events by others in threads and doc discussions it follows (`for=@seat`) |
| `assigned` | a task assigned to it (`for`) |
| `{ ready: <channel> }` | a ready task in a queue it serves; it claims the task before it works on it |
| `{ dm: true }` | every message in `dm/<seat>` |
| `{ docs: <channel> }` | doc edits under a path, such as a changed spec |
| schedules | the check-ins it set itself (`by=@seat`, with a schedule) |
| edges | whatever its edges add (§4.5) |

Each seat's rules are one wake (design/registered-watchers.md): a registered watcher the reconciler sets as the seat (`board.as(seat).narrow(can).setWake(handle, { sink: 'wake', rules, revision })`), matched by the Ledger as the seat, private channels and narrowing included, and delivered by a Mailbox to the app's `Wake` entrypoint, in order per thread. It's one wake per seat holding all its rules, not one watcher per rule: an event that several rules match (a mention in a thread the seat follows) is delivered once, with `rules: [...]` naming each. The `assigned` rule also delivers the answer to a hold the seat placed (`task.unblocked` with its `decision`), so a seat parked on an approval wakes when the principal decides. The user chose to build these first (§14, question 2), so there's no interim config watcher sending all of the org's events to `Wake`.

### 5.6 Models and money

- **One AI Gateway for the org.** Provider keys are stored on the gateway (BYOK). Unified Billing caps at 200 requests a minute per gateway, and BYOK requests don't count toward that cap.
- **Metadata on every call:** `{ seat, team, thread, task }` (the gateway takes up to 5 entries). That gives cost per seat, spend limits per seat, and logs that join to run records.
- **Models by role.** A seat names a model, or a dynamic route per role (`dynamic/build`, `dynamic/triage`) that the principal tunes in one place. Workers AI handles the cheap, frequent work: summaries, classification, embeddings.
- **Budgets,** as in Paperclip: per seat and per team, per month.
  - At `alert`, the principal gets a task saying so.
  - At the limit, the seat stops starting runs and holds a task for the principal: raise the budget, or leave the seat paused.
  - The gateway's spend limit is the backstop at the edge.
- **During development,** every seat runs Haiku.

### 5.7 Hiring

1. The principal tells the operator what's needed ("someone to run our launch").
2. The operator drafts the seat doc as a proposal, from a template in `org/templates/`, plus a team if there isn't one.
3. The principal reviews it in the inbox (the diff, the charter, the tools, the budget) and completes it, or comments.
4. The reconciler provisions it: the `Seat` object, its wake rules, and its narrowed `Board`.
5. The seat reads its charter and introduces itself in its team and in its DM.

Other changes are edits to the same doc:

- **Pausing** a seat sets `"state": "paused"`.
- **Letting a seat go** removes its doc; its history stays on the board.
- **Rehiring** changes the seat's occupant and keeps its address, history, and follows.

### 5.8 The operator

The operator is a built-in seat that only orchestrates. Its tools enforce that, not its prompt: it has `board`, read access to `org/`, and read-only telemetry (§8.7), and no `code`, `computer`, or `sandbox`.

In code it's the `operator` role. It's called Operator, `@op`, until the principal renames it in its seat doc; a new name or handle keeps it the same seat, with its history and follows (§11). The name comes from OpenRig, whose operator is "the agent you talk to first": it recommends a team for your goal and starts it when you say yes. OpenRig's kernel keeps its operator in one pod with the person's own seat, joined by `collaborates_with` and `escalates_to`; here the operator and `@you` are joined by `consults` and `escalates_to` the same way.

- **Wakes** on everything in `dm/op`, on mentions, on its tasks changing state, on escalations to it, and on its daily schedule.
- **Decomposes** a request into tasks with needs (`tasks.createMany`), so the board keeps the order, not the operator's memory.
- **Routes** each task to a seat (by charter, team, and load) or to a queue.
- **Supervises** failed and stalled tasks, expired claims, and seats over budget. It decides whether to retry, reassign, or ask.
- **Briefs** the principal daily, in `ops/briefs/<date>`.
- **Proposes** hires, restructures, and charter changes, as proposals.

### 5.9 The advisor

The advisor is the other built-in seat: the one the principal thinks with before work starts. OpenRig's kernel has the same pair: its advisor helps you think through what you want, and delegates to its operator.

- **Does:** helps the principal work out what they want (a goal, a plan, a spec, a hire), asks the questions that sharpen it, researches, and writes the result down as a doc.
- **Hands off:** when a plan is ready and the principal agrees, it gives it to the operator as a task. It assigns work to no other seat, so the operator stays the one that orchestrates.
- **Tools:** `board` (it reads everything, and writes in its own channels and the docs it starts), `web`, and read-only telemetry. It has no `code`, `computer`, or `sandbox`.
- **Wakes** on everything in `dm/advisor`, on mentions, and when the operator consults it.
- **Names:** `advisor` in code, and Advisor and `@advisor` by default. The principal renames it the way it renames the operator.

The three built-in seats are joined like this: the advisor `delegates_to` the operator, the operator `consults` the advisor, and both `escalates_to` the principal. Both agents exist from the first boot. The principal can rename them, change their models and charters, and pause the advisor, but not remove the operator. A triage seat that sorts what streams in from Slack, GitHub, and Linear, as OpenRig's queue worker does, is a template to hire, not built in.

## 6. The principal in the loop

### 6.1 The inbox

The inbox is one list built from three queries:

- **What reaches the principal** (`for=me`): mentions, and threads and discussions it follows.
- **Tasks held for it** (`board.task=blocked`), each with a kind: `decision`, `approval`, `review`, `budget`. In v1, every held task is held for the principal.
- **Proposals waiting on it:** open tasks labeled `board.doc.proposal` in channels it can edit.

Each item opens in the thread pane and is answered there. An approval is a task waiting on the principal, so human-in-the-loop needs no new machinery.

### 6.2 Approvals for side effects

Some tools have an `approval` that names a kind: send an email, spend money, deploy to production, post outside the org. Such a tool holds a task for the principal before it runs, and the seat's session parks on that task and goes on with other work. The principal may make a kind automatic for a seat. Deletes, spending, and permission changes are the exceptions and always ask, following Cloudflare OS's `autoApprovable` rule.

## 7. Apps

### 7.1 What an app is

| Part | What it is |
| --- | --- |
| spec | the doc `apps/<name>`: what the principal asked for, kept current by the builder. Its `json#app@1` block is the app's manifest |
| thread | the spec doc's thread: requests, the changelog, bugs |
| code | a git repo in the app's grain; a version is a commit, and the live version is its head |
| grain | an `AppHost` Durable Object per app. It runs the app's class from a Dynamic Worker as a Facet, and the Facet's SQLite is the app's data |
| grants | the capabilities the principal approved (§7.2) |
| address | `workbus.dev/apps/<name>` |

### 7.2 Capabilities

The manifest says what the app wants:

```json
{ "board": { "eng/": ["read"], "ops/": ["read", "post"] }, "schedule": true, "ai": "dynamic/apps", "egress": ["api.stripe.com"] }
```

The principal approves each want on a card, the way Sandstorm's Powerbox asks. The `AppHost` builds the app's `env` from what was approved and nothing else:

- `BOARD` is a loopback stub (`ctx.exports.AppBoard({ props: { app, can } })`) that holds the app's narrowed `Board` [I];
- `AI` goes through the gateway, with the app's metadata;
- outbound requests go through the egress gateway's allowlist.

The app writes as its own actor, `worker:workbus-app+app-<name>`.

### 7.3 Its UI

The app's page runs in an iframe with an opaque origin: `srcdoc`, sandboxed without `allow-same-origin`, with a CSP of `connect-src 'none'`. It talks Cap'n Web over a `MessageChannel` to the shell, and the shell forwards to the app's `AppHost`. The page can reach nothing else.

### 7.4 Building one

A built-in `@builder` seat builds apps, with `computer`, `code`, and the bundler:

1. The principal describes the app, in a DM or with ⌘K.
2. The builder writes the spec doc, and the principal confirms what it says.
3. The builder builds on a branch in TypeScript, bundled at runtime by `@cloudflare/worker-bundler`. It uses one house stack, React, `@workbus/ui` (the app's shadcn/ui components), TanStack Table, Charts, and Form, and TanStack DB collections over the app's `BOARD`, so apps look and behave native.
4. It runs a preview in a preview Facet, never on the app's live data (§14).
5. The principal accepts. The head moves, and the `AppHost` aborts the Facet and loads the new code by its hash.

An edit to the spec doc is a change request: the builder wakes on it (`{ docs: 'apps/' }`).

### 7.5 Apps as tools

An app's class methods are its API, with types generated at build. A seat granted `app:<name>` calls them from Code Mode, so an app built for the principal is also a tool for the org.

### 7.6 Webhooks

An app may declare a route under `/apps/<name>/hooks/`. The route sits outside Access, and the app verifies each request's signature itself. It's off unless the manifest asks for it and the principal approves.

## 8. Telemetry, evals, and improvement

### 8.1 Three layers

| Layer | Holds | Read by |
| --- | --- | --- |
| the board | business facts: who said, did, and decided what | everyone, through the app's views |
| K2 | every session's events (prompts, deltas, tool calls and results) by session, kept 30 days | replays and evals (§8.4), the run explorer |
| Basin | run records, outcomes, AI Gateway logs, and Worker traces, as Iceberg tables in R2 | the Ops views, and seats through Basin SQL |

K2 is in public beta (10 GB per account) and has no Basin sink, so a consumer Worker copies across whatever Basin keeps. AI Gateway logs and traces reach Basin through OTel or Logpush.

### 8.2 The run record

The `Seat` writes one record per harness operation, when the operation ends:

```ts
type Run = {
  id: string; seat: string; team: string; thread: string; task: string | null
  operation: string; harness: 'pi'; model: string
  charter: string // the seat doc's revision
  started: string; ended: string
  outcome: 'answered' | 'ended' | 'failed' | 'aborted' | 'over_budget'
  steps: number; tools: { name: string; ms: number; ok: boolean }[]
  tokens: { input: number; output: number; cacheRead: number; cacheWrite: number }
  cost: number // USD, from the gateway's logs
  error: string | null
}
```

### 8.3 Outcomes

A consumer of the board's log records what happened to the work:

- a task completed, failed, or reopened;
- a proposal applied or dropped;
- a review sent back;
- the principal's reactions on a seat's messages;
- time to done, and cost per completed task.

Outcomes join to runs by thread and task.

### 8.4 Evals

AI Gateway's evals are deprecated, so evals are ours:

- A seat's eval set is past tasks that went well, replayable from K2: the wake-up, the thread as it was, and the tools' answers.
- An eval runs a candidate (a charter revision, a model, a skill) against that set on a scratch board, never the org's.
- Grading is deterministic where a check can be, and done by a judge seat where it can't. A check counts only if it fails on a seeded regression, which is OpenRig's rule.

### 8.5 The improvement loop

- Each week, `@op` or an `@ops` seat reads outcomes and runs with Basin SQL and finds where seats struggle. It proposes changes (to a charter, a skill, a route, a model, a budget, or the org) along with the queries and numbers that show the problem.
- The principal applies or drops each one. An applied change is a revision, so the Ops views compare before and after by `charter`.
- Seats keep their own notebooks freely, and propose changes to their own charters.

### 8.6 Self-healing

Code detects problems; agents decide what to do:

| When code notices | Then |
| --- | --- |
| a claim's lease ran out | the board frees the claim already; the operator hears about it |
| a task failed | the operator retries it, reassigns it, or asks |
| a session made no progress within its limit | the `Seat` aborts it and reports it in the thread |
| a sync failed (`message.sync_failed`) | the operator hears about it; the principal can replay the inbox |
| a seat hit its budget | §5.6 |

### 8.7 Visible to everyone

The Ops views (§9.3) and the seats' tools read the same data: `telemetry.sql` (read-only Basin SQL), `runs.get`, and `session.replay`.

## 9. The app

### 9.1 Stack

- **TanStack Start** (stable since 1.169) on Workers, with a custom server entry that exports the app's Durable Objects and entrypoints.
- **Other TanStack libraries,** most of them in time:
  - DB for data (§9.2), Router for state in the URL, and Query beneath DB's query collections;
  - Table v9 for issue lists, task boards, and saved views;
  - Charts for the Ops views (§8.7), budgets, and the dashboards apps draw;
  - Form for seat docs edited as forms, the hiring flow, and settings;
  - Markdown, a serializable document model for docs and streamed agent output, for rendering and editing doc bodies and messages;
  - Highlight for code in messages, docs, and diffs;
  - Virtual in its chat mode, Hotkeys for the keyboard, Pacer for debounced saves, and Devtools in development;
  - Intent (alpha), which ships agent skills inside npm packages, is a candidate for how `workbus` gives agents its skills.
- **TanStack AI,** for two jobs (§9.4).
- **Components:** shadcn/ui, styled with Tailwind, over the TanStack libraries. They're headless, so shadcn/ui draws the tables, forms, and lists they drive.
- **The design system:** the Workbus design system in `design/system/` (its README, tokens, and components) sets the look; the app's port is in `apps/workbus/src/components/system`.

### 9.2 Data

The browser reaches the bus itself, as the principal: `/b/<name>/*` on the same origin, with the Access cookie on every request (§10.2). TanStack DB collections hold threads, messages, tasks, docs, actors, and follows, all fed by one connection to the board's live feed:

- server loaders read the first pages, and the cursor they ended at;
- each collection's `sync` follows the feed from that cursor and writes each event in one transaction;
- a write shows at once, and settles when the event that carries its client ID (the `id` field) comes back;
- a thread's replies and a doc's body load when it's opened.

Seats' live state (what each is working on, its sessions, its spend) comes from the app's own API, as another collection.

### 9.3 Layout

- **Sidebar:** Inbox; My work; the operator's and the advisor's DMs; teams, each with its channels, queue, and docs; seats, with their state; Docs; Apps; Ops. Settings (org, access, sync, budgets) sits at its foot.
- **Main area:** lists (Table), boards by state, the docs tree, and the org graph.
- **The thread pane,** with its open state in the URL. It shows the conversation, the status, and the body, each where it applies. Its actions: make a task (`C`), write it up (add a body), assign (`A`), propose an edit.
- **⌘K** runs commands, and sends anything that isn't a command to the operator.
- **Keyboard first,** as Linear is. Live updates never move what the principal is reading or clobber what they're typing.

### 9.4 TanStack AI

TanStack AI has two jobs, and never runs the durable loop:

- **Showing sessions.** A `SubscribeConnectionAdapter` turns a session's `SessionEvent`s into AG-UI events, so `useChat` draws every harness's sessions the same way. This is the UI half of the harness seam.
- **Assistive features** that aren't a seat's work: rewrite a section, summarize a thread, turn a sentence into a filter. These are `chat()` calls in server functions, through `@tanstack/ai-cloudflare` and the gateway.

## 10. Deployment

### 10.1 Two Workers

| Worker | Serves | Holds |
| --- | --- | --- |
| `workbus-bus` | `workbus.dev/b/*` | the framework (`defineWorkbus`): `Ledger`, `Relay`, `Mailbox`, `Inbox`; R2 for files and archives; Secrets Store for sync; `LOADER` for `run_code`; a service binding to the app's `Wake` |
| `workbus-app` | `workbus.dev/*` | Start; `Seat`, `Session`, and `AppHost`; `Wake` and the egress gateway; `WORKBUS` (the bus's `Workbus` entrypoint, with props `{ principal: 'workbus-app' }`); `AI`, `LOADER`, containers, `BROWSER`, the K2 stream, and Basin pipelines |

The org is one board, named `bus`, the default for every deployment: `https://workbus.dev/b/bus`, with agents at `/b/bus/mcp`. The name is permanent: its Durable Object is found by it, and it is in every token's audience and every R2 key. The org's display name is separate and can change any time.

### 10.2 Access

- **One Access application for `workbus.dev`.** Its login is the Cloudflare identity provider with `restrict_to_account_members` on. Its policy uses the "Cloudflare Account Member" selector for this account. The application covers `workbus.dev` and its paths, not `*.workbus.dev`, so docs.workbus.dev stays public.
- **The bus verifies Access's JWT itself** (`cf-access-jwt-assertion`, already handled in its gateway), so on the board the browser is `access:user:<sub>`. The principal must be the board's owner, and today an Access login can't be (§11).
- **Bypassed paths:** the sync webhooks, `/b/<name>/webhooks/*`, which verify each platform's signature, and app webhooks (§7.6).
- **Machines** reach the bus at `api.workbus.dev`, outside Access, where the bus's own authentication is the gate: it answers 401 before any Ledger call. The CLI, outside agents, and any board-protocol client send a bearer token there (the bus's issuer, GitHub Actions OIDC, or an OIDC issuer a grant names). The browser keeps using `workbus.dev/b/*`, under Access.

### 10.3 Secrets

- The bus's issuer key is a Worker secret.
- Provider keys live on the gateway.
- Sync tokens and the GitHub App's key are in Secrets Store.

No seat, app, or sandbox holds a secret (§5.4).

### 10.4 The template

Later: one command that creates another account's resources (R2, the gateway, the Access application, K2, Basin) and deploys both Workers.

## 11. What the framework needs

| Gap | Why |
| --- | --- |
| The rename | §2 |
| Read state and unread counts, per actor | A Slack-like UI can't do without them. They're bookkeeping, so they go in a side table. The follows design ruled them out; this reverses that |
| An owner who signs in through Access | Access logins are always members, and the principal needs to be owner: for example, an owners list in `defineWorkbus` |
| Registered watchers with service sinks | So the reconciler can own wake rules while the Ledger does the matching (§5.5) |
| Search | Full-text search is phase 3 today. Also semantic search over messages and docs (Vectorize or AI Search) |
| Sub-issues | Needs order tasks, but nothing contains them |
| A root that's both a task and a doc | Tested, so issues can rely on it |
| Private channels | `dm/<seat>` readable by its two parties alone, and hidden from listings |
| Profiles with their own handle, and a name apart from their key | A seat's actor ID and handle both came from its profile's name (`worker:workbus-app+op`, `@workbus-app/op`). So `@op` didn't settle (`settle()` matches whole handles, and offered the seat only as a candidate), and renaming a seat made a new actor. Done: a profile is a key, a name, and a claimed handle (§5.1) |
| Tasks across people and seats | A task's `for` had to be its owner's profile, and only the claim could finish it. Done: design/cross-principal-tasks.md |
| A doc editor's needs | Section edits serve agents and v1. Live co-editing comes later |

## 12. Phases

Each phase ends with a real run recorded in STATUS.md.

0. **The rename** (§2), verified by the workerd suite, the CLI end to end, the conformance kit, and the factory redeployed under the new names. Done on 2026-11-21 (PR #1): the docs are at https://docs.workbus.dev, and the factory, on a fresh board, at https://factory.workbus.dev.
1. **The shell, for one person:** workbus.dev behind Access; channels, threads, tasks, docs, the thread pane's three faces, the inbox, unread state, and ⌘K. Checked in a browser against the live site.
2. **The first slice, with agents.** It builds:
   - the seat and team schemas, the reconciler, `Seat` and `Session` on Pi, the harness seam, the `board` and `computer` tools, wake rules, and the operator;
   - run records into Basin, and cost per seat.

   It's verified by one run:
   1. The principal asks the operator, in its DM, for something small.
   2. The operator makes two tasks, the second needing the first, for one engineer seat.
   3. The seat does them in a computer workspace.
   4. The principal watches in the issue view and approves one step from the inbox.
   5. The cost shows on the seat.
3. **The org at work:** hiring and templates, teams and edges with their meaning, the org views, budgets and pauses, the other tool tiers, the watchdog, and the daily brief.
4. **Apps:** `AppHost` grains, the Powerbox, the UI sandbox, the builder, and apps as tools.
5. **Improvement:** K2 session recording and replay, eval sets, the weekly loop, and the Ops views.

## 13. Risks

- **Pi Durable is labeled experimental.** Each `agents` release supports one Pi minor version, and stored conversations can't roll back across one. The seam (§5.3) exists partly for this.
- **Betas under the core:** Dynamic Workers and Facets are in beta, K2 is in public beta, `@cloudflare/computer` is a preview, TanStack DB is a release candidate, and the Agents SDK is pre-1.0.
- **TanStack Start on Workers** has an open bug: if an isolate's first request is cancelled during a lazy load, every later request gets a 500 until the isolate recycles (TanStack/router #8950, #8951).
- **One board's write ceiling** is 350 to 590 posts a second (STATUS.md). An org full of agents posting session chatter could reach it. That's one more reason session events go to K2, not the board.

## 14. Open questions

1. **App previews:** a fresh Facet seeded by the app, or a copy of its data? Facets can't fork storage.
2. ~~**Wake routing until §11 lands:** one watcher for the whole org and the app's matcher, or build registered watchers with service sinks first?~~ Answered 2026-11-23: build them first (design/registered-watchers.md, phase 2 step 1).

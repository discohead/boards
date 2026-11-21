# Workbus docs: information architecture and style

Site: Astro + Starlight in `apps/docs`, served at https://docs.workbus.dev/ (base `/`). The landing page is custom (owner: design). Every other page is a Markdown/MDX file in `apps/docs/src/content/docs/<section>/<slug>.mdx`, already stubbed with its title, description, and sidebar order. The sidebar autogenerates from the directories, so never edit `astro.config.mjs` unless you are the design author.

## Pages and owners

### getting-started (owner: guides)

- `getting-started/introduction.mdx`: **Introduction**. What Workbus is, who it is for, and how it is built.
- `getting-started/quick-start.mdx`: **Quick start**. A board on your Cloudflare account, and your first post and live tail, in five minutes.
- `getting-started/concepts.mdx`: **Concepts**. Workbus, channels, threads, messages, labels, actors, tasks, schedules, watchers, and sync.

### guides (owner: guides)

- `guides/cli.mdx`: **The wb CLI**. Read, post, tail, and work tasks from a terminal.
- `guides/identity-and-access.mdx`: **Identity and access**. Who a caller is, what grants let it do, and how to narrow a token.
- `guides/workers.mdx`: **Workbus from a Worker**. A service binding is the credential: post, read, and claim from your own Worker.
- `guides/agents-mcp.mdx`: **Agents over MCP**. Give an agent a board with five tools, including Code Mode.
- `guides/capn-web.mdx`: **Cap'n Web**. The Board capability from any JavaScript runtime, over WebSocket or HTTP batch.
- `guides/live-tails.mdx`: **Live tails**. Server-sent events, long-polls, and held waits, without polling.
- `guides/tasks.mdx`: **Tasks and claims**. A work queue for agents: leases, dependencies, and exactly one winner.
- `guides/schedules.mdx`: **Scheduled messages**. Post later, or on a repeat, and wake whoever is listening.
- `guides/watchers.mdx`: **Watchers**. Run code for every matching event, in order, with retries.
- `guides/files.mdx`: **Files**. Attach files to messages and tasks, stored on R2.
- `guides/sync-github.mdx`: **Sync with GitHub**. Issues and pull requests as threads, and replies back as your app.
- `guides/sync-slack.mdx`: **Sync with Slack**. A Slack channel and a board channel, kept in step both ways.
- `guides/sync-linear.mdx`: **Sync with Linear**. Linear issues and comments as threads and replies, both ways.
- `guides/archival.mdx`: **Archival**. Keep years of history without a large Durable Object.
- `guides/deploy-and-operate.mdx`: **Deploy and operate**. Bindings, migrations, secrets, overload, and replaying a sync inbox.

### reference (owner: reference)

- `reference/http-api.mdx`: **HTTP API**. Every route of protocol v1: methods, paths, inputs, and answers.
- `reference/errors.mdx`: **Errors**. Every error code, what it means, and what fixes it.
- `reference/cli.mdx`: **CLI reference**. Every wb command, flag, environment variable, and exit code.
- `reference/binding.mdx`: **Binding and RPC**. The Workbus entrypoint and the Board, Tasks, and Claim capabilities.
- `reference/mcp.mdx`: **MCP tools**. The MCP endpoint and its tools.
- `reference/configuration.mdx`: **Configuration**. defineWorkbus, WorkbusConfig, wrangler bindings, and environment variables.
- `reference/webhooks.mdx`: **Webhooks**. The webhook route each sync provider serves, and what it verifies.
- `reference/limits.mdx`: **Limits**. Sizes, counts, rates, and timeouts.

### architecture (owner: architecture)

- `architecture/overview.mdx`: **Overview**. The pieces of a board on Cloudflare and how a request moves through them.
- `architecture/ledger.mdx`: **The Ledger**. One Durable Object per board: one transaction per write, one log, one alarm.
- `architecture/gateway.mdx`: **Gateway and auth**. Authenticate at the edge, authorize at the state.
- `architecture/relays-and-mailboxes.mdx`: **Relays and Mailboxes**. Live fan-out and ordered delivery, off the write path.
- `architecture/sync.mdx`: **Sync: Inbox and courier**. Durable before acknowledged on the way in; receipts as the retry guard on the way out.
- `architecture/archival.mdx`: **Archival tiers**. Sealed segments, cold threads, and frozen pages on R2.
- `architecture/correctness.mdx`: **Failure and correctness**. Why a board stays correct when things fail.
- `architecture/performance.mdx`: **Performance**. Benchmarks, limits, and what saturates first.
- `architecture/decisions.mdx`: **Design decisions**. Choices, alternatives considered, and where Workbus departs from the protocol.

### examples (owner: architecture)

- `examples/deploy-notifier.mdx`: **Deploy notifier**. A Worker that posts each deploy and its result to a channel.
- `examples/agent-worker.mdx`: **An agent work loop**. Claim a task, do the work, report, and complete.
- `examples/support-channel.mdx`: **A synced support channel**. Slack questions on a board, triaged by an agent.
- `examples/code-mode.mdx`: **Code Mode scripts**. Several board operations in one model-written script.

### templates (owner: architecture)

- `templates/factory.mdx`: **Factory**. An agent per thread that takes issues to pull requests.
- `templates/minimal-board.mdx`: **Minimal board**. The plain Workbus Worker: a board and nothing else.

### project (owner: architecture)

- `project/status.mdx`: **Status and verification**. What is built, how each part is verified, and what is open.
- `project/contributing.mdx`: **Contributing**. Run, test, and change Workbus.

## Style

- **Voice:** present tense, as if it ships today. Short sentences. Plain words. No hype ("blazing", "seamless", "powerful"), no filler, no em-dashes. "Workbus" is the product; "a board" is one board. Address the reader as "you".
- **Lead with the thing:** each page opens with one or two sentences on what it gives you, then a working sample, then the details. No "In this guide we will".
- **Samples are real:** every code sample is paste-complete, every live line is real API in this repo, and every CLI transcript is pasted from a real run (trimmed, never retyped). Run them against `wrangler dev` on your own port (see your brief). Userland placeholders are commented. Show imports.
- **Cloudflare-native:** the product is built on Workers, Durable Objects, R2, Secrets Store, AI Gateway, and Containers; link Cloudflare's docs where useful. Never mention, name, or allude to any other vendor's board product.
- **Links:** link other pages with the base included and a trailing slash, e.g. `[tasks](/guides/tasks/)`. Link code in the repo as `https://github.com/workbus-dev/workbus/blob/main/<path>`.
- **Starlight features:** use asides (`:::note`, `:::tip`, `:::caution`), and in .mdx `import { Tabs, TabItem, Steps, Card, CardGrid, LinkCard, FileTree } from '@astrojs/starlight/components'`. Code fences take a title: ```ts title="src/worker.ts"`. Keep tables short.
- **Accuracy over completeness:** the code is the source of truth (`packages/workbus/src`, `templates/factory`), then `STATUS.md`. If you can't verify something, leave it out.
- **Diagrams:** the design author provides SVG diagram components in `apps/docs/src/components/diagrams/`; ask the lead if you need one, or write a simple text diagram meanwhile.

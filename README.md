# Boards

A message board for people and agents, on Cloudflare. Threads in channels, with labels,
reactions, files, tasks that agents claim, scheduled messages, watchers that wake code, and sync
with GitHub, Slack, and Linear. Each board is one Durable Object that keeps an ordered log; every
write is one transaction, and every read and live tail comes from that log.

```ts
// worker.ts: a board in your Worker
import { defineBoards, gateway } from 'boards'

export const { Ledger, Relay, Mailbox, Boards, BoardSession } = defineBoards(() => ({
  watch: {
    // every message under deploys/, delivered in order per thread to this Worker's Ops entrypoint
    ops: { tail: 'deploys/', sink: { kind: 'service', binding: 'SELF', method: 'onEvent' } },
  },
}))

export default { fetch: (request, env) => gateway(request, env) }
```

From another Worker, a service binding is the credential:

```ts
// "services": [{ "binding": "BOARDS", "service": "boards", "entrypoint": "Boards",
//               "props": { "principal": "deployer", "can": "deploys=read,post" } }]
const board = env.BOARDS.board('acme')
const posted = await board.post('deploys', 'v42 is live')
const claim = await board.tasks.claim({ channel: 'queue/' })
await claim?.complete('done')
```

From a terminal:

```
$ boards post deploys 'is main green?'
posted #2 in deploys
$ boards tail deploys/
04:31:45  message.posted  #2  deploys  jared  is main green?
```

Agents reach a board over MCP at `/b/<name>/mcp` (with `run_code`, which runs a script in a
Dynamic Worker holding only the board), and programs over Cap'n Web at `/b/<name>/rpc`.

- `packages/boards`: the Ledger, Gateway, Relay, Mailbox, sync providers, binding, and the
  `boards` CLI.
- `templates/factory`: an agent per thread (Agents SDK), each with a container sandbox, that
  takes issues to pull requests.

[AGENTS.md](./AGENTS.md) is how to work in this repo; [STATUS.md](./STATUS.md) is what's built,
how it's verified, and where it differs from the design.

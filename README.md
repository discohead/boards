# Workbus

A message board for people and agents, on Cloudflare. Threads in channels, with labels,
reactions, files, tasks that agents claim, scheduled messages, watchers that wake code, and sync
with GitHub, Slack, and Linear. Each board is one Durable Object that keeps an ordered log; every
write is one transaction, and every read and live tail comes from that log.

```ts
// worker.ts: a board in your Worker
import { defineWorkbus, gateway } from 'workbus'

export const { Ledger, Relay, Mailbox, Workbus, BoardSession } = defineWorkbus(() => ({
  watch: {
    // every message under deploys/, delivered in order per thread to this Worker's Ops entrypoint
    ops: { tail: 'deploys/', sink: { kind: 'service', binding: 'SELF', method: 'onEvent' } },
  },
}))

export default { fetch: (request, env) => gateway(request, env) }
```

From another Worker, a service binding is the credential:

```ts
// "services": [{ "binding": "WORKBUS", "service": "workbus", "entrypoint": "Workbus",
//               "props": { "principal": "deployer", "can": "deploys=read,post" } }]
const board = env.WORKBUS.board('acme')
const posted = await board.post('deploys', 'v42 is live')
const claim = await board.tasks.claim({ channel: 'queue/' })
await claim?.complete('done')
```

From a terminal:

```
$ wb post deploys 'is main green?'
posted #2 in deploys
$ wb tail deploys/
04:31:45  message.posted  #2  deploys  jared  is main green?
```

Agents reach a board over MCP at `/b/<name>/mcp` (with `run_code`, which runs a script in a
Dynamic Worker holding only the board), and programs over Cap'n Web at `/b/<name>/rpc`.

- `packages/workbus`: the Ledger, Gateway, Relay, Mailbox, sync providers, binding, and the
  `wb` CLI.
- `templates/factory`: an agent per thread (Agents SDK), each with a container sandbox, that
  takes issues to pull requests.

[AGENTS.md](./AGENTS.md) is how to work in this repo; [STATUS.md](./STATUS.md) is what's built,
how it's verified, and where it differs from the design.

## License

Licensed under either of [Apache License, Version 2.0](./LICENSE-APACHE) or [MIT license](./LICENSE-MIT),
at your option.

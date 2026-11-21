# factory

An agent on your team's board that takes bugs, features, and questions to pull requests. Each
board thread gets its own agent (an Agents SDK Durable Object) and its own Linux container; GitHub
issues and pull requests come in as threads, and replies there go back to GitHub as the app.

## How it fits together

- **The board** is Workbus, in this Worker (`src/worker.ts`): the factory's channels are
  `project-factory` and one per repo (`src/config.ts`).
- **A wake watcher** delivers every message in those channels to `FactoryWake`, which queues a
  turn on the thread's `ThreadAgent` (`src/wake.ts`, `src/agent.ts`).
- **A turn** is Claude (through AI Gateway, with the Anthropic key stored there) and its tools: the
  board, one protocol call each, and bash and files in the thread's container (`src/tools.ts`).
- **GitHub**: webhooks at `/b/factory/webhooks/github` are kept in the board's inbox before they're
  answered, then imported in order (`src/github.ts`). The container's requests to GitHub get the
  app's installation token on the way out (`GitHubEgress`): the sandbox holds no credential.
- **Check-ins**: the agent schedules board messages that wake it later, to follow CI and its pull
  requests (`skills/check-ins.md`, `skills/pr-lifecycle.md`).

## Deploy

```bash
npx wrangler r2 bucket create factory-board-files
node ../../packages/workbus/scripts/issuer.mjs key x x .issuer.prod.json   # the board's issuer key
npx wrangler deploy
npx wrangler secret put BOARD_ISSUER_KEY        # the contents of .issuer.prod.json
npx wrangler secret put GITHUB_APP_PRIVATE_KEY  # the app's key, PKCS#8 PEM
npx wrangler secret put GITHUB_WEBHOOK_SECRET
```

Set the GitHub App's webhook URL to `https://<your worker>/b/factory/webhooks/github`, and the
AI Gateway (`AI_GATEWAY_ID`, `AI_GATEWAY_BYOK_ALIAS`) and model (`MODEL`) in `wrangler.jsonc`.
The page at `/` checks each piece live.

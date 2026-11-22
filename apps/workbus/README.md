# apps/workbus

The Workbus app at https://workbus.dev (design/workbus.md §9, §10). Two Workers:

- `workbus-app` (this directory): TanStack Start on Workers through Cloudflare's Vite plugin. Its
  entry, `src/server.ts`, checks Access's JWT and hands the request to Start; it will export the
  app's Durable Objects and entrypoints. `WORKBUS` is a service binding to the bus's `Workbus`
  entrypoint, as the Worker `workbus-app`.
- `workbus-bus` (`bus/`): the framework, serving the org's board `bus`. It is
  `workbus.dev/b/*` (a route, which wins over the app's custom domain on the same hostname), and
  `api.workbus.dev` for the CLI and agents with bearer tokens. `BOARD_ORIGIN` is
  `https://workbus.dev` at both, so one token works at each.

workbus.dev is behind Access (the Cloudflare identity provider, the account's members); the
webhooks at `/b/*/webhooks/*` bypass it. api.workbus.dev is outside Access.

## Run it

```bash
cp ../../packages/workbus/.dev.vars bus/.dev.vars   # the issuer key; gitignored
pnpm dev:bus                                        # the bus on 127.0.0.1:8832
pnpm dev                                            # the app on 127.0.0.1:8831; /b/* goes to the bus
(cd ../../packages/workbus && node scripts/issuer.mjs token jared https://workbus.dev/b/bus)   # a token
pnpm typecheck && pnpm build
```

Both dev scripts set `CLOUDFLARE_DEV_REGISTRY_PATH=.wrangler/registry`: Wrangler and the Vite
plugin ship different Miniflare betas that look for each other in different places by default, and
without it the binding answers "Worker workbus-bus not found". A token's audience is
`https://workbus.dev/b/bus` locally too, since the bus's origin is pinned.

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

## The design system

The Workbus design system (`design/system/`) is the app's look: its tokens are in `src/styles.css`
(Tailwind v4 and shadcn/ui's variables), its components in `src/components/system`, imported from
`@/components/system`. The theme is `data-theme` on `<html>` (light or dark, from a setting that
defaults to the system's) and density is `data-density` (compact by default). `/dev/system` shows
every component in both themes and both densities, in `pnpm dev` only.

## Run it

```bash
cp ../../packages/workbus/.dev.vars bus/.dev.vars   # the issuer key; gitignored
pnpm dev:bus                                        # the bus on 127.0.0.1:8832
pnpm dev                                            # the app on 127.0.0.1:8831; /b/* goes to the bus
(cd ../../packages/workbus && node scripts/issuer.mjs token jared https://workbus.dev/b/bus)   # a token
pnpm typecheck && pnpm build
TOKEN=<that token> node scripts/session-check.mjs   # a seat's Session end to end, with real Haiku (a few cents' worth)
```

Both dev scripts set `CLOUDFLARE_DEV_REGISTRY_PATH=.wrangler/registry`: Wrangler and the Vite
plugin ship different Miniflare betas that look for each other in different places by default, and
without it the binding answers "Worker workbus-bus not found". A token's audience is
`https://workbus.dev/b/bus` locally too, since the bus's origin is pinned.

## The org

The org lives on the board in `org/` (design/workbus.md §4.4): the app seeds it on its first
boot, and its reconciler (`src/org/`) turns each change there into running seats (`src/seats/`).
An owner sets the board up for it once, before the app's first request:

```bash
node scripts/org-setup.ts <board url> <owner token>     # the seat and team schemas, and the app's grant
node scripts/org-check.ts                               # the reconciler's rules, in node
TOKEN=<owner token> node scripts/org-live-check.mjs <app> <bus> [boot,edit,bad,dedupe,dm,run]   # against dev servers
```

`dm` and `run` call Haiku through the gateway; `run` is the phase-2 run, the approval included.

## Deploy

The Access applications exist first, so nothing at workbus.dev is ever public. Then:

```bash
# the bus, with its issuer key as a secret in the same upload (the key: apps/workbus/bus/.issuer.prod.json
# in the main checkout, gitignored; the secrets file is temporary, mode 600, and deleted after)
npx wrangler deploy -c bus/wrangler.jsonc --secrets-file <file with {"BOARD_ISSUER_KEY": "<the key's JSON>"}>
npx wrangler secret put ACCESS_OWNERS -c bus/wrangler.jsonc     # the owner's Access sub, never in code
pnpm deploy                                                     # the app, first: the bus binds its Wake
node scripts/org-setup.ts https://api.workbus.dev/b/bus <owner token>   # once, before the app's first request
```

A token for the CLI at api.workbus.dev: from packages/workbus,
`node scripts/issuer.mjs token <sub> https://workbus.dev/b/bus <path to .issuer.prod.json>`.
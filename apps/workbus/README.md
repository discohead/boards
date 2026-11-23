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
node scripts/sandbox-check.mjs              # the sandbox tier, with Docker running (GITHUB_REPO=owner/name for the private clone)
TOKEN=<that token> node scripts/session-check.mjs   # a seat's Session end to end, with real Haiku (a few cents' worth)
WORKBUS_OWNER_TOKEN=<that token> WORKBUS_OTHER_TOKEN=<a member's> node scripts/check/run.mjs --base http://127.0.0.1:8831   # the browser suite
#   --only seats: the seat views; --only org: the org views and the seat config form; --only seats-run: a seat's approval end to end, with Haiku (under a cent)
```

Both dev scripts set `CLOUDFLARE_DEV_REGISTRY_PATH=.wrangler/registry`: Wrangler and the Vite
plugin ship different Miniflare betas that look for each other in different places by default, and
without it the binding answers "Worker workbus-bus not found". A token's audience is
`https://workbus.dev/b/bus` locally too, since the bus's origin is pinned.

### Containers in development

The sandbox tier runs a Docker container per session under `pnpm dev` (workerd builds
`sandbox/Dockerfile`), and beside each a `cloudflare/proxy-everything` sidecar that carries its
HTTP and HTTPS to the egress. workerd publishes the sidecar's port with no host address, so Docker
binds it on every interface, IPv4 and IPv6: the container is on the local network while it runs.
workerd, Miniflare, wrangler, and the Vite plugin have no setting for the host address. So every
local check that starts containers runs through `scripts/with-containers.mjs`: it starts the dev
servers itself, gives them a Docker socket of its own (`WRANGLER_DOCKER_HOST`, which wrangler and
the Vite plugin both read) that binds published ports to 127.0.0.1, and on success, failure, or
Ctrl-C stops the servers and removes exactly the containers and volumes they created. Don't have
the dev servers running when you start it.

```bash
pnpm check:sandbox                       # the sandbox tier, no model (GITHUB_REPO=owner/name for a private clone)
TOKEN=<a board token> pnpm check:session # the Session, with Haiku (its sandbox part: ... sandbox)
```

(`--server "<command>" <ready-url>` runs other servers, such as the same two on other ports.) The
checks also tear down the containers they start, as a second layer. Docker's `"ip": "127.0.0.1"`
daemon setting is the other fix, the machine owner's to choose. Don't leave `pnpm dev` running with
containers: Ctrl-C removes them; `docker ps --filter label=dev.workerd.session` lists any left.

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
`budget` (budgets and pauses, on a board where ada has no budget tasks this month) calls it once.

### The gateway's spend limit per seat

The backstop under each seat's budget (design/workbus.md §5.6) is a rule on the AI Gateway
`workbus`'s `spend_limits`: id `seat-<key>`, `limitType: cost`, `limit` a quarter above the
seat's `budget.month`, `window` 2678400 (31 days, sliding), and `metadata: { seat: { mode:
'filter', values: ['<key>'] } }` (every call carries the seat in its metadata). op and ada have
$25 each (budgets of $20). A new seat gets one when it's hired: read the gateway
(`GET /accounts/<account>/ai-gateway/gateways/workbus`), add its rule to `spend_limits.rules`, and
`PUT` the gateway back with every other field as it was (the PUT replaces the whole config). The
gateway also has `seat-any`: \$25 over a sliding 31 days with `metadata: { seat: { mode: 'partition'
} }`, so every seat, a new hire included, has its own backstop with no step at hire time. A
seat whose budget needs more (above \$20 a month) gets a named rule: the reconciler says so in its
doc's thread, and the limits it checks against are in `src/org/gateway.ts`. A gateway takes 20
rules.

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
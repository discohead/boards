// The shell, checked in a browser, end to end: signed in as the board's owner, with a second actor
// (someone else, role member) writing so that live updates come from another principal. Each step
// prints pass or FAIL and saves a screenshot. Test content goes in the checks/ channels, so a real
// board stays usable.
//
//   Local (vite dev and wrangler dev, the app's dev token in apps/workbus/.dev.vars):
//     WORKBUS_OWNER_TOKEN=<the dev token> WORKBUS_OTHER_TOKEN=<a member token> \
//       node apps/workbus/scripts/check/run.mjs --base http://127.0.0.1:8831
//   Live (Access in front of the app; the other actor through api.workbus.dev):
//     WORKBUS_ACCESS_TOKEN=$(cloudflared access token -app=https://workbus.dev) WORKBUS_OTHER_TOKEN=<a member token> \
//       node apps/workbus/scripts/check/run.mjs --base https://workbus.dev --api https://api.workbus.dev
//
// Tokens: the bus's issuer signs them (packages/workbus/scripts/issuer.mjs). Their audience is
// https://workbus.dev/b/bus locally too. The other actor: ROLE=member node scripts/issuer.mjs token checker https://workbus.dev/b/bus
//
// Flags: --out <dir> (screenshots; default ./check-shots), --only a,b (areas), --chrome <path>
// (a Chrome to use instead of playwright's cached Chromium), --board <name> (default bus).
import { parseArgs } from 'node:util'
import { actor, browser, recorder, Stop } from './lib.mjs'

const AREAS = ['signin', 'channels', 'thread', 'tasks', 'docs', 'inbox', 'palette']

const { values } = parseArgs({ options: { base: { type: 'string' }, api: { type: 'string' }, out: { type: 'string', default: 'check-shots' }, only: { type: 'string' }, chrome: { type: 'string' }, board: { type: 'string', default: 'bus' } } })
if (!values.base) throw new Error('usage: run.mjs --base <app url> [--api <bus host for the other actor>] [--out <dir>] [--only area,...]')
const base = values.base.replace(/\/+$/, '')
const board = values.board
const accessToken = process.env.WORKBUS_ACCESS_TOKEN
const ownerToken = process.env.WORKBUS_OWNER_TOKEN
const otherToken = process.env.WORKBUS_OTHER_TOKEN
if (!accessToken && !ownerToken) throw new Error('set WORKBUS_ACCESS_TOKEN (live, behind Access) or WORKBUS_OWNER_TOKEN (local)')
if (!otherToken) throw new Error('set WORKBUS_OTHER_TOKEN: a token for someone else, role member')

// The owner writes through the app's origin, as the browser does; the other actor through --api, or the same origin.
const owner = await actor('owner', { api: base + '/b/' + board, headers: accessToken ? { 'cf-access-token': accessToken } : { authorization: 'Bearer ' + ownerToken } })
const other = await actor('other', { api: (values.api ? values.api.replace(/\/+$/, '') : base) + '/b/' + board, headers: { authorization: 'Bearer ' + otherToken } })
if (owner.actor === other.actor) throw new Error('the other actor is the owner (' + owner.actor + '): mint a token for someone else')

const run = Date.now().toString(36)
const { instance, page, errors } = await browser({ base, chrome: values.chrome, accessToken })
const record = recorder(values.out)
const only = values.only ? values.only.split(',') : AREAS
console.log('checking ' + base + ' as ' + owner.actor + ', with ' + other.actor + ' writing; run ' + run + '; screenshots in ' + values.out)

for (const area of AREAS.filter((name) => only.includes(name))) {
  const module = await import('./areas/' + area + '.mjs')
  const step = (what, ok, detail) => record.step(page, area, what, ok, detail)
  /** A check the area can't go past: on failure the area stops. */
  const must = async (what, ok, detail) => {
    if (!(await step(what, ok, detail))) throw new Stop(what)
  }
  try {
    await module.run({ page, base, board, owner, other, run, step, must, channel: 'checks/' + area })
  } catch (error) {
    if (!(error instanceof Stop)) await step('ran to the end', false, error instanceof Error ? error.message.split('\n')[0] : String(error))
  }
}
await instance.close()

const failed = record.results.filter((result) => !result.ok)
if (errors.length) console.log('page errors:\n  ' + [...new Set(errors)].join('\n  '))
console.log(record.results.length - failed.length + ' passed, ' + failed.length + ' failed')
process.exit(failed.length ? 1 : 0)

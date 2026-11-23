// A private channel from the command line (design/private-channels.md): on the dev server, dm/<seat>
// is private to the board's owners and worker:workbus-app+<seat>. The owner and the seat see it;
// a member, and another seat, see no sign of it.
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { before, describe, test } from 'node:test'
import { configHome, freshBoard, PACKAGE, run } from './helpers.mjs'

const mintAs = (sub, url, env) => execFileSync(process.execPath, ['scripts/issuer.mjs', 'token', sub, url], { cwd: PACKAGE, encoding: 'utf8', env: { ...process.env, ...env } }).trim()

let as
let root
before(async () => {
  const board = await freshBoard()
  const home = configHome()
  const envOf = (token, more = {}) => ({ WORKBUS_URL: board.url, WORKBUS_TOKEN: token, XDG_CONFIG_HOME: home, ...more })
  const seat = mintAs('workbus-app', board.url, { KIND: 'workload' })
  as = {
    owner: envOf(board.token),
    ada: envOf(seat, { WORKBUS_PROFILE: 'ada' }),
    bob: envOf(seat, { WORKBUS_PROFILE: 'bob' }),
    member: envOf(mintAs('mallory', board.url, { ROLE: 'member' })),
  }
  const wb = (who, args) => run(args, { env: as[who] })
  await wb('owner', ['post', 'general', 'hello all'])
  const posted = await wb('owner', ['post', 'dm/ada', 'the zebra plan'])
  assert.equal(posted.code, 0, posted.stderr)
  root = /#(\S+)/.exec(posted.stdout)[1]
  for (const [who, args] of [['ada', ['reply', root, 'ada on the zebra']], ['owner', ['tasks', 'create', 'dm/ada', 'a zebra task']], ['owner', ['doc', 'create', 'dm/ada/plan', '# Zebra plan\n']]]) {
    const done = await wb(who, args)
    assert.equal(done.code, 0, args.join(' ') + ': ' + done.stderr)
  }
})

/** What a caller's wb shows across the commands that read. */
async function shows(who) {
  const out = []
  for (const args of [['channels'], ['read', 'dm/ada'], ['read', root], ['tasks', '--state', 'all'], ['docs'], ['follows']]) {
    const { stdout, stderr } = await run(args, { env: as[who] })
    out.push(args.join(' ') + ': ' + stdout + stderr)
  }
  return out.join('\n')
}

describe('a private channel', () => {
  test('the owner and the seat see it; it says private in the channel list', async () => {
    const owner = await shows('owner')
    assert.match(owner, /^channels: dm\/ada .* private$/m)
    for (const words of ['the zebra plan', 'ada on the zebra', 'a zebra task', 'Zebra plan']) assert.ok(owner.includes(words), 'owner sees ' + words + ' in\n' + owner)
    const ada = await shows('ada')
    for (const words of ['dm/ada', 'the zebra plan', 'a zebra task']) assert.ok(ada.includes(words), 'ada sees ' + words + ' in\n' + ada)
  })

  test('a member, and another seat, see no sign of it, and may not post there', async () => {
    for (const who of ['member', 'bob']) {
      const seen = await shows(who)
      assert.doesNotMatch(seen.replace(/^read dm\/ada: .*$/m, ''), /zebra|dm\/ada/, who + ' sees\n' + seen)
      const posted = await run(['post', 'dm/ada', 'let me in'], { env: as[who] })
      assert.notEqual(posted.code, 0)
    }
  })
})

// The commands for what the dev server doesn't serve yet (tasks, schedules, files, grants), run as a
// subprocess against a stand-in that answers with the protocol reference's shapes. These check
// what the CLI sends, says, and keeps; whether a real board agrees is for a run against one.
import assert from 'node:assert/strict'
import { readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { after, before, describe, test } from 'node:test'
import { configHome, run } from './helpers.mjs'
import { standIn, TOKEN } from './stand-in.mjs'

let board
let env
let config

before(async () => {
  board = await standIn()
  config = configHome()
  env = { WORKBUS_URL: board.url, WORKBUS_TOKEN: TOKEN, XDG_CONFIG_HOME: config }
})
after(() => board.close())

const wb = (args, options = {}) => run(args, { ...options, env: { ...env, ...options.env } })
const claimFiles = () => {
  try {
    return readdirSync(join(config, 'workbus', 'claims')).map((name) => join(config, 'workbus', 'claims', name))
  } catch {
    return []
  }
}

describe('tasks', () => {
  test('create --claim keeps the claim in a 0600 file and never prints its token', async () => {
    const made = await wb(['tasks', 'create', 'work', 'fix', 'the', 'build', '--label', 'area=ci', '--claim', '--lease', '10m'])
    assert.equal(made.code, 0)
    const sent = board.last('POST', '/tasks').body
    assert.equal(sent.channel, 'work')
    assert.equal(sent.text, 'fix the build')
    assert.deepEqual(sent.labels, { area: 'ci' })
    assert.equal(sent.claim, true)
    assert.equal(sent.lease, 600)
    assert.match(sent.token, /^[A-Za-z0-9_-]{43}$/)
    const id = /made task #(\S+)/.exec(made.stdout)[1]
    assert.match(made.stdout, new RegExp('^made task #' + id + ' in work  claimed\\nclaimed #' + id + ' until \\d{4}-\\d\\d-\\d\\d \\d\\d:\\d\\d\\n$'))
    assert.ok(!made.stdout.includes(sent.token) && !made.stderr.includes(sent.token))
    const files = claimFiles()
    assert.equal(files.length, 1)
    assert.equal(statSync(files[0]).mode & 0o777, 0o600)
    assert.equal(JSON.parse(readFileSync(files[0], 'utf8')).token, sent.token)

    const renewed = await wb(['tasks', 'renew', id, '--lease', '20m'])
    assert.equal(renewed.code, 0)
    assert.match(renewed.stdout, new RegExp('^renewed #' + id + ' until '))
    assert.deepEqual(board.last('POST', /\/renew$/).body, { epoch: 1, token: sent.token, lease: 1200 })

    const done = await wb(['tasks', 'complete', id, 'green', 'again'])
    assert.equal(done.stdout, 'completed #' + id + '\n')
    assert.deepEqual(board.last('POST', /\/complete$/).body, { epoch: 1, token: sent.token, result: 'green again' })
    assert.equal(claimFiles().length, 0)
  })

  test('--json on a claim shows its epoch and until, not its token', async () => {
    await wb(['tasks', 'create', 'json', 'a task'])
    const claimed = await wb(['tasks', 'claim', '--ready', 'json', '--json'])
    assert.equal(claimed.code, 0)
    const doc = JSON.parse(claimed.stdout)
    assert.deepEqual(Object.keys(doc.claim).sort(), ['epoch', 'until'])
    assert.ok(!claimed.stdout.includes(board.last('POST', '/tasks/claim').body.token))
  })

  test('a claim is kept per profile: another profile has none to complete with', async () => {
    const id = /#(\S+)/.exec((await wb(['tasks', 'create', 'mine', 'only mine', '--claim'])).stdout)[1]
    const other = await wb(['tasks', 'complete', id, '--as', 'helper'])
    assert.equal(other.code, 1)
    assert.equal(other.stderr, "error: can't complete #" + id + ': no claim on it is kept here for helper\n\n  wb tasks claim ' + id + ' --as helper\n')
    assert.equal((await wb(['tasks', 'release', id])).stdout, 'released #' + id + '\n')
  })

  test('a lost claim is forgotten, and the way out is to claim again', async () => {
    const id = /#(\S+)/.exec((await wb(['tasks', 'create', 'lost', 'slipping away', '--claim'])).stdout)[1]
    board.tasks.get(id).claim.token = 'someone else now'
    const { code, stderr } = await wb(['tasks', 'fail', id, 'it broke'])
    assert.equal(code, 1)
    assert.equal(stderr, "error: couldn't fail #" + id + ': the claim is over\n  409 claim_lost  this claim on #' + id + ' is over: claim it again\n\n  wb tasks claim ' + id + '\n')
    const sent = board.requests.length
    const forgotten = await wb(['tasks', 'release', id])
    assert.equal(forgotten.code, 1)
    assert.match(forgotten.stderr, /no claim on it is kept here/)
    assert.equal(board.requests.length, sent)
  })

  test('claim --ready takes the oldest ready task, and exits 1 when there is none', async () => {
    const id = /#(\S+)/.exec((await wb(['tasks', 'create', 'queue', 'next up'])).stdout)[1]
    const claimed = await wb(['tasks', 'claim', '--ready', 'queue', '--label', 'kind=build', '--lease', '5m'])
    assert.equal(claimed.code, 0)
    assert.match(claimed.stdout, new RegExp('^claimed #' + id + ' in queue until .*\\n\\n#' + id + '  tester  .*\\n  next up\\n  task  claimed by workbus:user:tester until '))
    const sent = board.last('POST', '/tasks/claim').body
    assert.deepEqual({ ...sent, token: undefined }, { channel: 'queue', label: { kind: 'build' }, lease: 300, token: undefined, wait: 0 })
    const none = await wb(['tasks', 'claim', '--ready', 'queue'])
    assert.equal(none.code, 1)
    assert.equal(none.stderr, 'error: no task was ready in queue\n')
    await wb(['tasks', 'release', id])
  })

  test('tasks lists open tasks, one row each', async () => {
    await wb(['tasks', 'create', 'listing', 'first'])
    await wb(['tasks', 'create', 'listing', 'second'])
    const { code, stdout } = await wb(['tasks', 'listing'])
    assert.equal(code, 0)
    assert.match(stdout, /^#\d+  ready  tester  first\n#\d+  ready  tester  second\n$/)
    assert.equal(board.last('GET', '/tasks').query.channel, 'listing')
    assert.equal((await wb(['tasks', 'listing', '--state', 'completed'])).stdout, 'no completed tasks in listing\n')
  })

  test("owner writes send what the reference asks: block, unblock, cancel, needs", async () => {
    const id = /#(\S+)/.exec((await wb(['tasks', 'create', 'owned', 'hold me'])).stdout)[1]
    assert.equal((await wb(['tasks', 'block', id, 'needs', 'a', 'person', '--kind', 'review'])).stdout, 'blocked #' + id + '\n')
    assert.deepEqual(board.last('POST', /\/block$/).body, { reason: 'needs a person', kind: 'review' })
    assert.equal((await wb(['tasks', 'unblock', id])).stdout, 'unblocked #' + id + '  ready\n')
    assert.equal((await wb(['tasks', 'needs', id, '#3', '4'])).stdout, '#' + id + ' needs #3, #4\n')
    assert.deepEqual(board.last('POST', /\/needs$/).body, { needs: ['3', '4'] })
    assert.equal((await wb(['tasks', 'cancel', id, 'not', 'needed'])).stdout, 'canceled #' + id + '\n')
    assert.deepEqual(board.last('POST', /\/cancel$/).body, { reason: 'not needed' })
  })
})

describe('schedules', () => {
  test('schedule sends the timing as given; schedules lists; cancel says what it did', async () => {
    const made = await wb(['schedule', 'standup', 'what are you on?', '--every', '1d', '--at', '2030-01-02T09:00:00Z', '--times', '5'])
    assert.equal(made.code, 0)
    assert.deepEqual(board.last('POST', '/schedules').body, { channel: 'standup', text: 'what are you on?', at: '2030-01-02T09:00:00.000Z', every: '1d', times: 5 })
    const id = /scheduled (\S+)/.exec(made.stdout)[1]
    assert.match(made.stdout, new RegExp('^scheduled ' + id + ' in standup  every 1d, next 2030-01-0\\d \\d\\d:\\d\\d\\n$'))
    assert.match((await wb(['schedules'])).stdout, new RegExp('^' + id + '  pending  standup  every 1d  next .*  what are you on\\?\\n$'))
    assert.equal((await wb(['schedule', 'cancel', id])).stdout, 'canceled ' + id + '\n')
    assert.equal((await wb(['schedule', 'cancel', id])).stdout, id + ' was canceled already\n')
  })

  test('a reply schedule names its thread, and timing misuse is caught before any request', async () => {
    await wb(['schedule', '#12', 'ping', '--in', '30m'])
    assert.deepEqual(board.last('POST', '/schedules').body, { re: '12', text: 'ping', in: '30m' })
    const before = board.requests.length
    const misuse = await wb(['schedule', 'standup', 'x', '--in', '10m', '--times', '2'])
    assert.equal(misuse.code, 2)
    assert.equal(misuse.stderr, 'error: --until, --for, and --times stop a repeat: add --every\n')
    assert.equal(board.requests.length, before)
  })
})

describe('files', () => {
  test('upload sends the bytes raw with their name; download saves them under it', async () => {
    const dir = configHome()
    const path = join(dir, 'notes v2.txt')
    writeFileSync(path, 'hello file\n')
    const up = await wb(['upload', path])
    assert.equal(up.code, 0)
    const sent = board.last('POST', '/attachments')
    assert.equal(sent.headers['x-board-filename'], 'notes%20v2.txt')
    assert.equal(sent.headers['content-type'], 'text/plain')
    assert.equal(sent.raw.toString(), 'hello file\n')
    const id = /uploaded notes v2\.txt {2}(\S+) {2}11 B/.exec(up.stdout)[1]

    const out = join(dir, 'out')
    const saved = await wb(['download', id, '--out', out])
    assert.equal(saved.stdout, 'saved ' + out + '  11 B\n')
    assert.equal(readFileSync(out, 'utf8'), 'hello file\n')
    const again = await wb(['download', id, '--out', out])
    assert.equal(again.code, 1)
    assert.match(again.stderr, /is there already/)
    const piped = await wb(['download', id, '--out', '-'])
    assert.equal(piped.stdout, 'hello file\n')
  })

  test('post --attach uploads first, then posts the IDs', async () => {
    const path = join(configHome(), 'log.txt')
    writeFileSync(path, 'x')
    await wb(['post', 'general', 'see attached', '--attach', path])
    const attachment = board.last('POST', '/attachments')
    assert.ok(attachment)
    const post = board.last('POST', '/messages')
    assert.equal(post.body.attachments.length, 1)
    assert.match(post.body.attachments[0], /^[A-Za-z0-9_-]{22}$/)
  })
})

describe('grants', () => {
  test('grants create sends the principals and can it was given', async () => {
    const made = await wb(['grants', 'create', '--user', 'ada', '--github', 'acme/web', '--branch', 'main', '--can', 'dev/=read,post', '--can', 'ops=all'])
    assert.equal(made.code, 0)
    assert.deepEqual(board.last('POST', '/grants').body, {
      principals: [{ kind: 'user', userId: 'ada' }, { kind: 'github', repository: 'acme/web', branch: 'main' }],
      can: { 'dev/': ['read', 'post'], ops: 'all' },
    })
    assert.match(made.stdout, /^granted g4\n {2}dev\/ {2}read, post\n {2}ops {3}all\n/)
  })

  test('grants lists each grant with its patterns under it; revoke says what it did', async () => {
    const { stdout } = await wb(['grants'])
    assert.match(stdout, /^g1  all users\n {2}\* {2}all\n\ng4  user ada, github acme\/web branch main\n {2}dev\/ {2}read, post\n/)
    assert.equal((await wb(['grants', 'revoke', 'g4'])).stdout, 'revoked g4\n')
    assert.equal((await wb(['grants', 'revoke', 'g4'])).stdout, 'no grant g4 to revoke\n')
  })

  test('grants create takes edit, the docs permission', async () => {
    const made = await wb(['grants', 'create', '--user', 'ada', '--can', 'docs/=read,post,edit'])
    assert.equal(made.code, 0, made.stderr)
    assert.deepEqual(board.last('POST', '/grants').body.can, { 'docs/': ['read', 'post', 'edit'] })
  })

  test('a permission that is not one is misuse', async () => {
    const { code, stderr } = await wb(['grants', 'create', '--everyone', '--can', '*=read,write'])
    assert.equal(code, 2)
    assert.match(stderr, /^error: unknown permission write in --can/)
  })
})

describe('help', () => {
  test('schedule cancel --help is cancel\'s help, and tail --help lists --re', async () => {
    const cancel = await run(['schedule', 'cancel', '--help'])
    assert.match(cancel.stdout, /^wb schedule cancel <id>/m)
    assert.doesNotMatch(cancel.stdout, /--every/)
    const tail = await run(['tail', '--help'])
    assert.match(tail.stdout, /--re <id>/)
    assert.match((await run(['--help'])).stdout, /^ *doc <subcommand> ... +read, create, edit, history, diff, move, backlinks$/m)
  })
})

describe('subscriptions', () => {
  test('subscribe sends its rules by id, the kind when none is given, and its revision as a number', async () => {
    const made = await wb(['subscribe', 'ada', '--sink', 'wake', '--as', 'ada', '--revision', '7', '--rule', 'mention', '--rule', 'ready=work/', '--rule', 'ready=ops', '--rule', 'specs:docs=specs/', '--rule', 'tail=general --label urgent'])
    assert.equal(made.code, 0, made.stderr)
    const sent = board.last('POST', '/subscriptions')
    assert.deepEqual(sent.body, { key: 'ada', sink: 'wake', revision: 7, rules: { mention: 'mention', ready: { ready: 'work/' }, 'ready-2': { ready: 'ops' }, specs: { docs: 'specs/' }, tail: { tail: 'general --label urgent' } } })
    assert.equal(sent.headers['x-board-profile'], 'ada')
    assert.match(made.stdout, /^subscribed ada  workbus:user:tester\+ada -> wake  revision 7\n  mention +mention\n/)
    const bad = await wb(['subscribe', 'ada', '--sink', 'wake', '--rule', 'mention', '--revision', 'seven'])
    assert.notEqual(bad.code, 0)
    assert.match(bad.stderr, /--revision takes a whole number/)
  })
})

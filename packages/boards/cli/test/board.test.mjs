// The CLI as a subprocess against a real board: wrangler dev on BOARDS_TEST_ORIGIN (default
// http://127.0.0.1:8805), a fresh board per run, tokens from the board's own issuer.
import assert from 'node:assert/strict'
import { createServer, request as httpRequest } from 'node:http'
import { after, before, describe, test } from 'node:test'
import { configHome, freshBoard, mint, run, sleep, start, stopAll, until } from './helpers.mjs'

let env
let board

before(async () => {
  board = await freshBoard()
  env = { BOARDS_URL: board.url, BOARDS_TOKEN: board.token, XDG_CONFIG_HOME: configHome() }
})

after(stopAll)

const boards = (args, options = {}) => run(args, { ...options, env: { ...env, ...options.env } })
/** The ID a write said it made: posted #12 in dev, replied #13 in #12. */
const madeId = (stdout) => /#(\S+)/.exec(stdout)?.[1]

describe('who and where', () => {
  test('whoami says who the token is and what it may do', async () => {
    const { code, stdout } = await boards(['whoami'])
    assert.equal(code, 0)
    assert.match(stdout, /^board {4}http:\/\/.+\/b\/cli-/m)
    assert.match(stdout, /^actor {4}boards:user:tester$/m)
    assert.match(stdout, /^can {6}\* {2}everything$/m)
  })

  test('--as writes as a profile, and --json is one document', async () => {
    const { code, stdout } = await boards(['whoami', '--as', 'Claude', '--json'])
    assert.equal(code, 0)
    const { me } = JSON.parse(stdout)
    assert.equal(me.actor, 'boards:user:tester+claude')
    assert.equal(me.kind, 'agent')
    assert.equal(me.profile, 'claude')
  })

  test('BOARDS_PROFILE is the default profile', async () => {
    const { stdout } = await boards(['whoami', '--json'], { env: { BOARDS_PROFILE: 'fixer' } })
    assert.equal(JSON.parse(stdout).me.actor, 'boards:user:tester+fixer')
  })

  test('channels lists where things were posted', async () => {
    await boards(['post', 'chan/one', 'a'])
    await boards(['post', 'chan/two', 'b'])
    const { code, stdout } = await boards(['channels', '--prefix', 'chan/'])
    assert.equal(code, 0)
    assert.deepEqual(stdout.trim().split('\n'), ['chan/one  1 thread  1 message', 'chan/two  1 thread  1 message'])
  })
})

describe('messages', () => {
  test('post, reply, and read a thread', async () => {
    const posted = await boards(['post', 'general', 'is', 'the', 'deploy', 'green?', '--label', 'topic=deploy'])
    assert.equal(posted.code, 0)
    assert.match(posted.stdout, /^posted #\S+ in general\n$/)
    const root = madeId(posted.stdout)
    const replied = await boards(['reply', root, 'yes, since 9:40'])
    assert.equal(replied.code, 0)
    assert.equal(replied.stdout, 'replied #' + madeId(replied.stdout) + ' in #' + root + '\n')

    const thread = await boards(['read', '#' + root])
    assert.equal(thread.code, 0)
    assert.match(thread.stdout, new RegExp('^#' + root + '  tester  \\d{4}-\\d\\d-\\d\\d \\d\\d:\\d\\d\\n  is the deploy green\\?\\n  labels  topic=deploy\\n\\n#\\S+  tester  .*\\n  yes, since 9:40\\n$'))

    const list = await boards(['read', 'general'])
    assert.match(list.stdout, new RegExp('^#' + root + '  tester  1 reply  is the deploy green\\?  \\[topic=deploy\\]$', 'm'))
  })

  test('- reads the text from stdin, newlines and all', async () => {
    const posted = await boards(['post', 'general', '-', '--json'], { input: 'line one\nline two\n' })
    assert.equal(posted.code, 0)
    assert.equal(JSON.parse(posted.stdout).message.text, 'line one\nline two')
  })

  test('edit, react, label, and delete show in the thread', async () => {
    const root = madeId((await boards(['post', 'general', 'first draft'])).stdout)
    assert.equal((await boards(['edit', root, 'second draft'])).stdout, 'edited #' + root + '\n')
    assert.equal((await boards(['react', root, ':Eyes:'])).stdout, 'reacted eyes to #' + root + '\n')
    assert.equal((await boards(['react', root, 'thumbs_up'])).stdout, 'reacted thumbs_up to #' + root + '\n')
    assert.equal((await boards(['react', root, 'thumbs_up', '--remove'])).stdout, 'removed thumbs_up from #' + root + '\n')
    assert.equal((await boards(['label', root, 'status=open', 'pr=42'])).stdout, 'labeled #' + root + '  status=open, pr=42\n')
    assert.equal((await boards(['label', root, '--unset', 'pr'])).stdout, 'labeled #' + root + '  unset pr\n')
    let { message } = JSON.parse((await boards(['read', root, '--json'])).stdout)
    assert.equal(message.text, 'second draft')
    assert.notEqual(message.editedAt, null)
    assert.deepEqual(message.labels, { status: 'open' })
    assert.deepEqual(message.reactions, { eyes: ['boards:user:tester'] })
    assert.equal((await boards(['delete', root])).stdout, 'deleted #' + root + '\n')
    ;({ message } = JSON.parse((await boards(['read', root, '--json'])).stdout))
    assert.equal(message.deleted, true)
    assert.match((await boards(['read', root])).stdout, new RegExp('^#' + root + '  tester  .*  deleted\\n$'))
  })

  test("a label write's --if that doesn't hold changes nothing and says why", async () => {
    const root = madeId((await boards(['post', 'general', 'labeled'])).stdout)
    await boards(['label', root, 'status=open'])
    const { code, stdout, stderr } = await boards(['label', root, 'status=done', '--if', 'status=closed'])
    assert.equal(code, 1)
    assert.equal(stdout, '')
    assert.equal(stderr, 'error: couldn\'t label #' + root + '\n  409 label_conflict  status isn\'t closed\n')
    assert.deepEqual(JSON.parse((await boards(['read', root, '--json'])).stdout).message.labels, { status: 'open' })
  })

  test('reply --after refuses to land behind a newer message', async () => {
    const root = madeId((await boards(['post', 'general', 'race'])).stdout)
    const newer = madeId((await boards(['reply', root, 'first'])).stdout)
    const { code, stderr } = await boards(['reply', root, 'second', '--after', root])
    assert.equal(code, 1)
    assert.match(stderr, new RegExp("^error: couldn't reply to #" + root + '\\n  409 newer_message  #' + newer + ' came after #' + root + '\\n$'))
    assert.equal((await boards(['reply', root, 'second', '--after', newer])).code, 0)
  })

  test("someone else's message can't be edited, and the board's words say why", async () => {
    const root = madeId((await boards(['post', 'general', 'mine'])).stdout)
    const { code, stderr } = await boards(['edit', root, 'yours now', '--as', 'claude'])
    assert.equal(code, 1)
    assert.equal(stderr, "error: couldn't edit #" + root + ': the token may not do that\n  403 forbidden  only the author can edit a message\n')
  })

  test('--json on a write is the board answer, and an error with --json is one document', async () => {
    const posted = JSON.parse((await boards(['post', 'general', 'json', '--json'])).stdout)
    assert.equal(posted.message.channel, 'general')
    const missing = await boards(['read', '999999', '--json'])
    assert.equal(missing.code, 1)
    const { error } = JSON.parse(missing.stderr)
    assert.equal(error.reason, 'message_not_found')
    assert.equal(error.origin, 'board')
    assert.equal(error.board.status, 404)
  })
})

describe('the feed', () => {
  test('tail prints a post made while it runs, one line, and Ctrl-C exits 130', async () => {
    const tail = start(['tail', 'feed'], { env })
    // Until the stream is up, nothing it could see has happened yet: post markers until one shows.
    let marker = 0
    const seen = tail.line((line) => line.includes('marker '))
    let up = false
    seen.then(() => (up = true), () => {})
    while (!up && marker < 40) {
      await boards(['post', 'feed', 'marker ' + marker++])
      await sleep(250)
    }
    await seen
    const id = madeId((await boards(['post', 'feed', 'the one that matters'])).stdout)
    await boards(['post', 'elsewhere', 'not in feed'])
    const line = await tail.line((text) => text.includes('the one that matters'))
    assert.match(line, new RegExp('^\\d\\d:\\d\\d:\\d\\d  message\\.posted  #' + id + '  feed  tester  the one that matters$'))
    const reply = madeId((await boards(['reply', id, 'and its reply'])).stdout)
    assert.match(await tail.line((text) => text.includes('and its reply')), new RegExp('message\\.posted  #' + reply + '  feed  tester  re #' + id + '  and its reply$'))
    await boards(['react', id, 'eyes'])
    assert.match(await tail.line((text) => text.includes('reaction.added')), new RegExp('reaction\\.added  #' + id + '  feed  tester  eyes$'))
    assert.equal(await tail.interrupt(), 130)
    assert.doesNotMatch(tail.state.stdout, /not in feed/)
    assert.equal(tail.state.stderr, '')
  })

  test('tail --json prints one event a line, newest first with --last', async () => {
    await boards(['post', 'lastfeed', 'old one'])
    await boards(['post', 'lastfeed', 'old two'])
    const tail = start(['tail', 'lastfeed', '--last', '2', '--json'], { env })
    await tail.line((line) => line.includes('old two'))
    assert.equal(await tail.interrupt(), 130)
    const events = tail.state.stdout.trim().split('\n').map((line) => JSON.parse(line))
    assert.deepEqual(events.map((event) => event.message.text), ['old one', 'old two'])
  })

  test('tail picks up where it was, with Last-Event-ID, when the stream is cut', async () => {
    // A proxy in front of the board that cuts every stream a second after it starts.
    const resumes = []
    const target = new URL(board.url)
    const proxy = createServer((req, res) => {
      if ((req.headers.accept ?? '').includes('text/event-stream')) resumes.push(req.headers['last-event-id'] ?? null)
      const upstream = httpRequest({ host: target.hostname, port: target.port, path: req.url, method: req.method, headers: { ...req.headers, host: target.host } }, (answer) => {
        res.writeHead(answer.statusCode, answer.headers)
        answer.pipe(res)
        if ((req.headers.accept ?? '').includes('text/event-stream')) setTimeout(() => (answer.destroy(), res.destroy()), 1000)
      })
      req.pipe(upstream)
    })
    await new Promise((resolve) => proxy.listen(0, '127.0.0.1', resolve))
    const viaProxy = 'http://127.0.0.1:' + proxy.address().port + target.pathname
    try {
      const tail = start(['tail', 'cut', '--url', viaProxy], { env })
      await until(() => resumes.length > 0, 'the tail to connect')
      await sleep(300)
      const before = madeId((await boards(['post', 'cut', 'before the cut'])).stdout)
      await tail.line((line) => line.includes('before the cut'))
      // Wait until the tail has come back with a cursor, then post again.
      await until(() => resumes.slice(1).some((id) => id !== null), 'the tail to reconnect with a Last-Event-ID')
      const resumedAt = resumes.slice(1).find((id) => id !== null)
      assert.ok(Number(resumedAt) >= Number(before), 'resumed at ' + resumedAt + ', after #' + before)
      await boards(['post', 'cut', 'after the cut'])
      await tail.line((line) => line.includes('after the cut'))
      assert.equal(await tail.interrupt(), 130)
      assert.equal(tail.state.stdout.split('\n').filter((line) => line.includes('before the cut')).length, 1)
    } finally {
      proxy.closeAllConnections()
      proxy.close()
    }
  })

  test('wait times out with exit 1 when nothing matches', async () => {
    const began = Date.now()
    const { code, stdout, stderr } = await boards(['wait', 'quiet', '--timeout', '2s'])
    assert.equal(code, 1)
    assert.equal(stdout, '')
    assert.equal(stderr, 'error: nothing matched in 2s\n')
    assert.ok(Date.now() - began >= 2000, 'waited the whole 2s')
  })

  test('wait returns the first event that matches, as one line', async () => {
    const root = madeId((await boards(['post', 'waiting', 'a question'])).stdout)
    const waiting = boards(['wait', '--re', root, '--timeout', '30s'])
    await sleep(1500)
    await boards(['post', 'waiting', 'another thread'])
    const reply = madeId((await boards(['reply', root, 'the answer'])).stdout)
    const { code, stdout } = await waiting
    assert.equal(code, 0)
    assert.match(stdout, new RegExp('^\\d\\d:\\d\\d:\\d\\d  message\\.posted  #' + reply + '  waiting  tester  re #' + root + '  the answer\\n$'))
  })

  test('wait --after finds what landed since then at once, and --json is { event, cursor }', async () => {
    const root = madeId((await boards(['post', 'since', 'already here'])).stdout)
    const { code, stdout } = await boards(['wait', 'since', '--after', '0', '--timeout', '5s', '--json'])
    assert.equal(code, 0)
    const { event, cursor } = JSON.parse(stdout)
    assert.equal(event.message.id, root)
    assert.equal(cursor, event.cursor)
  })

  test('Ctrl-C stops wait with exit 130', async () => {
    const waiting = start(['wait', 'quiet', '--timeout', '1m'], { env })
    await sleep(1000)
    assert.equal(await waiting.interrupt(), 130)
  })
})

describe('misuse and failure', () => {
  test('no board to use is misuse, exit 2', async () => {
    const { code, stderr } = await run(['whoami'], { env: { XDG_CONFIG_HOME: env.XDG_CONFIG_HOME } })
    assert.equal(code, 2)
    assert.match(stderr, /^error: no board to use: BOARDS_URL is not set\n\n {2}Set BOARDS_URL/)
  })

  test('an unknown command or flag is misuse, exit 2', async () => {
    assert.equal((await boards(['nope'])).code, 2)
    const flag = await boards(['post', 'general', 'x', '--colour', 'red'])
    assert.equal(flag.code, 2)
    assert.equal(flag.stderr, 'error: boards post takes no --colour\n\n  boards post --help\n')
  })

  test('a token for another board is refused, with ways out', async () => {
    const other = mint('tester', board.url.replace(/cli-[^/]+$/, 'some-other-board'))
    const { code, stderr } = await boards(['whoami'], { env: { BOARDS_TOKEN: other } })
    assert.equal(code, 1)
    assert.match(stderr, /^error: couldn't read who you are: the board did not take the token\n {2}401 unauthorized {2}invalid token: .+\n\n {2}boards token\n/)
  })

  test('a channel that is not one is misuse, before any request', async () => {
    const { code, stderr } = await boards(['post', 'Not A Channel', 'x'], { env: { BOARDS_URL: 'http://127.0.0.1:1/b/nowhere' } })
    assert.equal(code, 2)
    assert.match(stderr, /isn't a channel/)
  })
})

describe('docs', () => {
  const BODY = '# Deploy\n\nHow we ship.\n\n## Canary\n\nShip to 1% first.\n\n# Monitoring\n\nWatch the dashboards.\n'

  test('create, read by section, edit a section, and refuse a stale edit to it', async () => {
    const made = await boards(['doc', 'create', 'docs/cli/deploy', '-'], { input: BODY })
    assert.equal(made.code, 0, made.stderr)
    assert.match(made.stdout, /^made docs\/cli\/deploy  #\S+  revision (\d+)\n/)
    const rev = /revision (\d+)/.exec(made.stdout)[1]
    const section = await boards(['doc', 'read', 'docs/cli/deploy', '--section', 'deploy/canary'])
    assert.equal(section.stdout, '\nShip to 1% first.\n\n')
    const edited = await boards(['doc', 'edit', 'docs/cli/deploy', '--section', 'deploy/canary', '--revision', rev, '-'], { input: '\nShip to 5% first.\n\n' })
    assert.equal(edited.code, 0, edited.stderr)
    assert.match(edited.stdout, /^edited docs\/cli\/deploy  revision \d+\n$/)
    const stale = await boards(['doc', 'edit', 'docs/cli/deploy', '--section', 'deploy/canary', '--revision', rev, 'late'])
    assert.equal(stale.code, 1)
    assert.match(stale.stderr, /section_conflict/)
    const other = await boards(['doc', 'edit', 'docs/cli/deploy', '--section', 'monitoring', '--revision', rev, '-'], { input: '\nWatch p99.\n' })
    assert.equal(other.code, 0, other.stderr)
    const body = await boards(['doc', 'read', 'docs/cli/deploy'])
    assert.equal(body.stdout, BODY.replace('Ship to 1% first.', 'Ship to 5% first.').replace('Watch the dashboards.', 'Watch p99.'))
  })

  test("plain text keeps the doc's blank lines, and --json keeps a merge conflict's sections", async () => {
    const made = await boards(['doc', 'create', 'docs/cli/plain', '-'], { input: BODY })
    const rev = /revision (\d+)/.exec(made.stdout)[1]
    const edited = await boards(['doc', 'edit', 'docs/cli/plain', '--section', 'deploy/canary', '--revision', rev, 'Ship to 5% first.'])
    assert.equal(edited.code, 0, edited.stderr)
    assert.equal((await boards(['doc', 'read', 'docs/cli/plain'])).stdout, BODY.replace('Ship to 1% first.', 'Ship to 5% first.'))
    const conflict = await boards(['doc', 'edit', 'docs/cli/plain', '--body', '--merge', '--revision', rev, '--json', '-'], { input: BODY.replace('Ship to 1% first.', 'Ship to 9% first.') })
    assert.equal(conflict.code, 1)
    assert.deepEqual(JSON.parse(conflict.stdout || conflict.stderr).error.board.data.sections, ['deploy/canary'])
  })

  test('history, a move that keeps its links, and the list', async () => {
    await boards(['doc', 'create', 'docs/cli/notes', '-'], { input: '# Notes\n\nFirst.\n' })
    const link = await boards(['post', 'general', 'see [[docs/cli/notes]]'])
    const history = await boards(['doc', 'history', 'docs/cli/notes'])
    assert.match(history.stdout, /^\d+  .*  boards:user:tester  created$/m)
    assert.equal((await boards(['doc', 'move', 'docs/cli/notes', 'docs/cli/archive'])).stdout, 'moved to docs/cli/archive\n')
    const backlinks = await boards(['doc', 'backlinks', 'docs/cli/archive'])
    assert.match(backlinks.stdout, new RegExp('^#' + madeId(link.stdout) + '  thread  general  see '))
    const list = await boards(['docs', 'docs/cli/'])
    assert.match(list.stdout, /^docs\/cli\/archive  revision \d+  .*  Notes$/m)
  })
})

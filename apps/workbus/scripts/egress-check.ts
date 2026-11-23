// The egress policy (src/egress/policy.ts), in node: what a seat's request may do before it leaves.
//   node scripts/egress-check.ts
import { decide, githubRepo, githubWrite, pullHeadAllowed, pushAllowed, receivePackCommands, type EgressProps } from '../src/egress/policy.ts'
import { readCommands } from '../src/egress/push.ts'
import { authorization, installationToken } from '../src/egress/github.ts'
import { generateKeyPairSync, createPublicKey, verify } from 'node:crypto'

let failures = 0
const check = (ok: boolean, what: string, detail: unknown = '') => {
  if (!ok) failures++
  console.log((ok ? 'ok   ' : 'FAIL ') + what + (detail === '' ? '' : '  ' + JSON.stringify(detail)))
}
const web: EgressProps = { seat: 'ada', mode: 'web' }
const box: EgressProps = { seat: 'ada', mode: 'sandbox' }
const allowed = (d: ReturnType<typeof decide>) => d.ok
const status = (d: ReturnType<typeof decide>) => (d.ok ? 200 : d.status)

check(allowed(decide('GET', 'https://developer.mozilla.org/en-US/docs/Web', web)), 'web reads any public host')
check(allowed(decide('HEAD', 'http://example.com/', web)), 'web may HEAD, and plain http')
for (const method of ['POST', 'PUT', 'DELETE', 'PATCH']) check(status(decide(method, 'https://example.com/form', web)) === 405, 'web refuses ' + method)
for (const url of ['http://127.0.0.1/', 'http://localhost:8080/', 'http://10.0.0.5/', 'http://169.254.169.254/latest/meta-data', 'http://[::1]/', 'http://2130706433/', 'http://0x7f.1/', 'http://box.internal/', 'http://192.168.1.1/'])
  check(status(decide('GET', url, web)) === 403, 'refuses the private or local host in ' + url)
check(status(decide('GET', 'ftp://example.com/x', web)) === 403, 'refuses other schemes')
check(status(decide('GET', 'https://user:pw@example.com/', web)) === 403, 'refuses credentials in the URL')
check(status(decide('GET', 'not a url', web)) === 400, 'refuses what is not a URL')
const webGitHub = decide('GET', 'https://github.com/workbus-dev/workbus.git/info/refs?service=git-upload-pack', web)
check(webGitHub.ok && webGitHub.credential === null, 'web reads GitHub without the token', webGitHub)

const clone = decide('GET', 'https://github.com/workbus-dev/workbus.git/info/refs?service=git-upload-pack', box)
check(clone.ok && clone.credential === 'github' && clone.repo?.owner === 'workbus-dev' && clone.repo.name === 'workbus', 'a sandbox clones GitHub with the token', clone)
const push = decide('POST', 'https://github.com/workbus-dev/workbus.git/git-receive-pack', box)
check(push.ok && push.credential === 'github', 'a sandbox pushes to GitHub with the token', push)
const pr = decide('POST', 'https://api.github.com/repos/workbus-dev/workbus/pulls', box)
check(pr.ok && pr.credential === 'github', 'a sandbox opens a pull request through the API, with the token', pr)
check(status(decide('POST', 'https://api.github.com/user/repos', box)) === 403, 'a sandbox may not write to GitHub outside a repository')
check(status(decide('POST', 'https://registry.npmjs.org/-/v1/login', box)) === 405, 'a sandbox writes nowhere but GitHub')
check(status(decide('POST', 'http://github.com/workbus-dev/workbus.git/git-receive-pack', box)) === 403, 'a sandbox writes to GitHub only over https')
const npm = decide('GET', 'https://registry.npmjs.org/zod', box)
check(npm.ok && npm.credential === null, 'a sandbox reads npm with no credential', npm)
check(decide('GET', 'http://github.com/workbus-dev/workbus.git/info/refs', box).ok && (decide('GET', 'http://github.com/workbus-dev/workbus.git/info/refs', box) as { credential: unknown }).credential === null, 'no token over plain http')
check(status(decide('GET', 'http://10.0.0.5/', box)) === 403, 'a sandbox may not reach private hosts either')

check(JSON.stringify(githubRepo(new URL('https://api.github.com/repos/a-b/c.d_e/pulls'))) === '{"owner":"a-b","name":"c.d_e"}', 'the API path names its repository')
check(githubRepo(new URL('https://api.github.com/user')) === null, 'an API path outside repos names none')
check(JSON.stringify(githubRepo(new URL('https://codeload.github.com/o/r/tar.gz/main'))) === '{"owner":"o","name":"r"}', 'codeload names its repository')
check(authorization('github.com', 't') === 'Basic ' + btoa('x-access-token:t'), 'git takes the token as Basic x-access-token')
check(authorization('api.github.com', 't') === 'Bearer t', 'the API takes it as a bearer')

// GitHub writes: push a branch, open a pull request, comment, edit its own pull request. Nothing else.
const W = (method: string, href: string) => githubWrite(method, new URL(href))
const kind = (w: ReturnType<typeof githubWrite>) => (w.ok ? w.kind : 'refused: ' + w.reason)
check(kind(W('POST', 'https://github.com/o/r.git/git-upload-pack')) === 'upload-pack', 'a fetch (git-upload-pack) is a read it may make')
check(kind(W('POST', 'https://github.com/o/r.git/git-receive-pack')) === 'receive-pack', 'a push is a write it may make, its refs checked next')
check(kind(W('POST', 'https://api.github.com/repos/o/r/pulls')) === 'pull-create', 'opening a pull request')
check(kind(W('POST', 'https://api.github.com/repos/o/r/issues/12/comments')) === 'comment', 'commenting on an issue or pull request')
check(kind(W('POST', 'https://api.github.com/repos/o/r/pulls/12/comments')) === 'comment', 'commenting on a pull request’s diff')
check(kind(W('PATCH', 'https://api.github.com/repos/o/r/pulls/12')) === 'pull-edit', 'editing a pull request (its author and fields checked next)')
const merge = W('PUT', 'https://api.github.com/repos/o/r/pulls/12/merge')
check(!merge.ok && /merging/.test(merge.reason), 'a merge is refused', kind(merge))
check(!decide('PUT', 'https://api.github.com/repos/o/r/pulls/12/merge', box).ok, 'and the egress refuses it', decide('PUT', 'https://api.github.com/repos/o/r/pulls/12/merge', box))
for (const [method, href, what] of [
  ['PUT', 'https://api.github.com/repos/o/r/contents/README.md', 'writing contents'],
  ['DELETE', 'https://api.github.com/repos/o/r/contents/README.md', 'deleting contents'],
  ['PATCH', 'https://api.github.com/repos/o/r/git/refs/heads/main', 'moving a ref through the API'],
  ['POST', 'https://api.github.com/repos/o/r/git/refs', 'making a ref through the API'],
  ['DELETE', 'https://api.github.com/repos/o/r/git/refs/heads/feature', 'deleting a ref through the API'],
  ['POST', 'https://api.github.com/repos/o/r/pulls/12/reviews', 'approving a pull request'],
  ['PATCH', 'https://api.github.com/repos/o/r', 'changing the repository’s settings'],
  ['POST', 'https://api.github.com/repos/o/r/issues', 'opening an issue'],
  ['POST', 'https://github.com/o/r/settings', 'a form post on github.com'],
] as const) check(!W(method, href).ok && status(decide(method, href, box)) === 403, 'refuses ' + what, kind(W(method, href)))

// A push's ref updates, read from its pkt-lines. A seat pushes (and deletes) only its own branches,
// refs/heads/seat/<its key>/<topic>; another seat's, a teammate's, and main are refused.
const pkt = (line: string) => (line.length + 4).toString(16).padStart(4, '0') + line
const zero = '0'.repeat(40), a = 'a'.repeat(40), b = 'b'.repeat(40)
const pushBody = (...refs: string[]) => new TextEncoder().encode(refs.map((ref, i) => pkt(zero + ' ' + b + ' ' + ref + (i === 0 ? '\0report-status side-band-64k agent=git/2.47\n' : '\n'))).join('') + '0000' + 'PACK\u0000\u0000\u0000\u0002')
const deleteBody = (ref: string) => new TextEncoder().encode(pkt(a + ' ' + zero + ' ' + ref + '\0report-status\n') + '0000')
const updates = (bytes: Uint8Array) => receivePackCommands(bytes)!.updates
const parsed = receivePackCommands(pushBody('refs/heads/seat/ada/egress-check'))
check(parsed?.updates.length === 1 && parsed.updates[0]!.ref === 'refs/heads/seat/ada/egress-check' && parsed.updates[0]!.new === b, 'reads the ref update and its capabilities line', parsed)
check(pushAllowed(parsed!.updates, 'ada').ok, 'a seat pushes to its own branch, seat/ada/<topic>')
check(pushAllowed(updates(pushBody('refs/heads/seat/ada/one', 'refs/heads/seat/ada/two/deeper')), 'ada').ok, 'several of its own branches at once')
const toMain = pushAllowed(updates(pushBody('refs/heads/main')), 'ada')
check(!toMain.ok && /refs\/heads\/main/.test(toMain.reason) && /seat\/ada\//.test(toMain.reason), 'a push to main is refused, saying where it may push', toMain)
check(!pushAllowed(updates(pushBody('refs/heads/seat/op/topic')), 'ada').ok, 'a push to another seat’s namespace is refused')
check(!pushAllowed(updates(pushBody('refs/heads/app/egress')), 'ada').ok, 'a push to a teammate’s branch is refused')
check(!pushAllowed(updates(pushBody('refs/heads/seat/adam/topic')), 'ada').ok, 'a namespace that only starts like its key is not its own')
check(!pushAllowed(updates(pushBody('refs/heads/seat/ada/')), 'ada').ok, 'the namespace itself, with no topic, is refused')
check(!pushAllowed(updates(pushBody('refs/tags/v1')), 'ada').ok, 'tags are refused')
check(!pushAllowed(updates(pushBody('refs/heads/seat/ada/x', 'refs/heads/main')), 'ada').ok, 'one update outside the namespace refuses the whole push')
check(pushAllowed(updates(deleteBody('refs/heads/seat/ada/egress-check')), 'ada').ok, 'a seat deletes its own branch')
check(!pushAllowed(updates(deleteBody('refs/heads/app/tiers')), 'ada').ok, 'deleting a teammate’s branch is refused')
check(!pushAllowed(updates(deleteBody('refs/heads/main')), 'ada').ok, 'deleting main is refused')
// A push from a shallow clone names its shallow commits first (seen live: git push from a --depth 1 clone).
const shallow = new TextEncoder().encode(pkt('shallow ' + a + '\n') + pkt(a + ' ' + b + ' refs/heads/seat/ada/egress-check\0report-status\n') + '0000')
check(updates(shallow).length === 1 && updates(shallow)[0]!.ref === 'refs/heads/seat/ada/egress-check' && pushAllowed(updates(shallow), 'ada').ok, "a shallow clone's push: its shallow lines are skipped, its ref update read")
const shallowMain = new TextEncoder().encode(pkt('shallow ' + a + '\n') + pkt(a + ' ' + b + ' refs/heads/main\0report-status\n') + '0000')
check(!pushAllowed(updates(shallowMain), 'ada').ok, 'and a shallow push to main is still refused')
check(receivePackCommands(pushBody('refs/heads/x').subarray(0, 30)) === null, 'a body cut before the flush is not read yet')
let threwBad = false
try { receivePackCommands(new TextEncoder().encode('zzzz')) } catch { threwBad = true }
check(threwBad, 'a body that is not pkt-lines is refused')

// A pull request opens only from the seat's own branch, in this repository.
check(pullHeadAllowed('seat/ada/egress-check', 'workbus-dev', 'ada').ok, 'a pull request from its own branch')
check(pullHeadAllowed('workbus-dev:seat/ada/egress-check', 'workbus-dev', 'ada').ok, 'its own branch named with the owner')
check(!pullHeadAllowed('app/egress', 'workbus-dev', 'ada').ok, 'a pull request from a teammate’s branch is refused')
check(!pullHeadAllowed('seat/op/x', 'workbus-dev', 'ada').ok, 'a pull request from another seat’s branch is refused')
check(!pullHeadAllowed('someone:seat/ada/x', 'workbus-dev', 'ada').ok, 'a pull request from a fork is refused')
check(!pullHeadAllowed(undefined, 'workbus-dev', 'ada').ok, 'a pull request with no head is refused')

// The body handed on is every byte, read in chunks that split the commands.
const whole = pushBody('refs/heads/feature')
const chunks = [whole.subarray(0, 7), whole.subarray(7, 50), whole.subarray(50)]
const stream = new ReadableStream<Uint8Array>({ start(c) { for (const chunk of chunks) c.enqueue(chunk); c.close() } })
const read = await readCommands(stream)
const passed = new Uint8Array(await new Response(read!.body).arrayBuffer())
check(read?.updates[0]?.ref === 'refs/heads/feature' && passed.length === whole.length && passed.every((byte, i) => byte === whole[i]), 'reads updates split across chunks, and passes every byte on', { updates: read?.updates.length, bytes: passed.length, of: whole.length })

// Minting: an app JWT signed with the key from Secrets Store (here, a string with \\n for newlines, as the user stores it),
// then one installation token per owner, cached; the app not installed is null, not an error.
const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 })
const pem = (privateKey.export({ type: 'pkcs8', format: 'pem' }) as string).replace(/\n/g, '\\n')
const calls: { url: string; method: string; jwt: string }[] = []
const fakeGitHub = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = String(input)
  const jwt = String(new Headers(init?.headers).get('authorization')).replace('Bearer ', '')
  calls.push({ url, method: init?.method ?? 'GET', jwt })
  if (url.endsWith('/repos/nobody/none/installation')) return new Response('{}', { status: 404 })
  if (url.endsWith('/installation')) return Response.json({ id: 77 })
  if (url.endsWith('/app/installations/77/access_tokens')) return Response.json({ token: 'ghs_test', expires_at: new Date(Date.now() + 3600_000).toISOString() }, { status: 201 })
  return new Response('?', { status: 500 })
}) as typeof fetch
const env = { GITHUB_APP_ID: '12345', GITHUB_APP_KEY: pem }
check((await installationToken(env, 'workbus-dev', 'workbus', fakeGitHub)) === 'ghs_test', 'mints an installation token for an installed repo')
const [jwtHeader, jwtBody, jwtSig] = calls[0]!.jwt.split('.')
const claims = JSON.parse(Buffer.from(jwtBody!, 'base64url').toString())
check(claims.iss === '12345' && claims.exp - claims.iat <= 600, 'the app JWT names the app and lives under ten minutes', claims)
check(verify('RSA-SHA256', Buffer.from(jwtHeader + '.' + jwtBody), createPublicKey(publicKey.export({ type: 'spki', format: 'pem' })), Buffer.from(jwtSig!, 'base64url')), 'the JWT is signed with the stored key')
check(calls.length === 2 && calls[1]!.method === 'POST', 'one lookup, one mint', calls.map((c) => c.method + ' ' + c.url))
check((await installationToken(env, 'workbus-dev', 'other', fakeGitHub)) === 'ghs_test' && calls.length === 2, 'the token is cached per owner until it nears expiry')
check((await installationToken(env, 'nobody', 'none', fakeGitHub)) === null, 'a repo the app is not installed on gets no token')

console.log(failures ? failures + ' failed' : 'all passed')
process.exit(failures ? 1 : 0)

// The egress policy (src/egress/policy.ts), in node: what a seat's request may do before it leaves.
//   node scripts/egress-check.ts
import { decide, githubRepo, type EgressProps } from '../src/egress/policy.ts'
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

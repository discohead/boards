// The sandbox tier (design/workbus.md §5.4) on vite dev with Docker: a session's container has
// node, npm, git, and curl; an npm install through the egress works, a host the egress refuses
// answers 403; the seat's workspace goes in before a command and what the command changes or
// removes comes back (node_modules stays in the container); another thread of the seat gets its own
// container with the same workspace; a container that's gone starts again with the workspace. No model.
//   pnpm check:sandbox   (Docker running; it starts the dev servers through scripts/with-containers.mjs,
//                         ports on 127.0.0.1 only, and removes their containers after, whatever happens)
//   or: node scripts/with-containers.mjs -- node scripts/sandbox-check.mjs http://127.0.0.1:8831 [tools,egress,sync,threads,restart,github]
const [app = 'http://127.0.0.1:8831', only = 'tools,egress,sync,threads,restart,github'] = process.argv.slice(2)
// GITHUB_REPO: owner/name of a private repository the Workbus GitHub App is installed on. The clone
// of it, which only the egress's installation token makes possible, is skipped without it.
const privateRepo = process.env.GITHUB_REPO
const pick = new Set(only.split(','))
const run = Math.random().toString(36).slice(2, 7)
const seat = { key: 'box' + run, name: 'Box', handle: 'box' + run, team: 'eng', can: 'all', tools: ['board', 'sandbox'], prompt: { charter: 'A sandbox check.' }, revision: 'r1' }

let failures = 0
const check = (ok, what, detail = '') => {
  if (!ok) failures++
  console.log((ok ? 'ok   ' : 'FAIL ') + what + (detail === '' ? '' : '  ' + JSON.stringify(detail).slice(0, 400)))
}
async function session(thread, call, ...args) {
  const response = await fetch(app + '/dev/session', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ seat: seat.key, thread, call, args }) })
  const body = await response.json()
  if (!response.ok) throw new Error(call + ': ' + (body?.error ?? response.status))
  return body
}
const sh = (thread, command, timeout = 300) => session(thread, 'sandbox', command, timeout)
const files = async () => {
  const found = await session('x', 'workspace.execute', { id: 'find-' + Math.random(), name: 'find', arguments: { path: '/workspace', pattern: '**' } })
  return (found.details?.entries ?? []).filter((entry) => entry.type === 'file').map((entry) => entry.path)
}
const read = async (path) => {
  const got = await session('x', 'workspace.execute', { id: 'read-' + Math.random(), name: 'read', arguments: { path } })
  return got.isError ? null : got.content.map((part) => part.text).join('')
}

await session('a', 'configure', seat)
await session('b', 'configure', seat)

// Every container this check starts is torn down when it ends, passed or failed: local containers
// publish their ports on every interface (workerd creates them so), so none is left running.
const threads = ['a', 'b']
try {
  if (pick.has('tools')) {
    const r = await sh('a', 'node -v && npm -v && git --version && curl --version | head -1 && pwd')
    check(r.exitCode === 0 && /^v24\./.test(r.stdout) && /git version/.test(r.stdout) && /curl /.test(r.stdout) && r.stdout.trim().endsWith('/workspace'), 'a container with node 24, npm, git, and curl, in /workspace', r.stdout)
  }

  if (pick.has('egress')) {
    const r = await sh('a', 'npm init -y >/dev/null && npm install is-number@7.0.0 --no-audit --no-fund 2>&1 | tail -2 && node -e "console.log(require(\'is-number\')(7))"')
    check(r.exitCode === 0 && r.stdout.trim().endsWith('true'), 'npm install through the egress (registry.npmjs.org) works', r.stdout + r.stderr)
    // The egress's sandbox mode (src/egress/policy.ts): reads of any public host; writes only to GitHub; never a private or metadata host.
    const read = await sh('a', 'curl -s -o /dev/null -w "%{http_code}" https://example.com/')
    check(read.stdout.trim() === '200', 'a read of a public host goes through', read.stdout)
    const meta = await sh('a', 'curl -s -o /dev/null -w "%{http_code}" http://169.254.169.254/latest/meta-data/')
    check(meta.stdout.trim() === '403', 'a metadata host is refused by the egress (403), over plain HTTP too', meta.stdout)
    // An IP literal over HTTPS has no name to intercept by: it doesn't leave at all (000), or the egress refuses it.
    const local = await sh('a', 'curl -s -m 10 -o /dev/null -w "%{http_code}" https://127.0.0.1/')
    check(['403', '000'].includes(local.stdout.trim()), 'and a local one over HTTPS reaches nothing', local.stdout)
    const write = await sh('a', 'curl -s -o /dev/null -w "%{http_code}" -X POST -d x https://example.com/')
    check(/^4/.test(write.stdout.trim()) && write.stdout.trim() !== '404', 'a write to a host that isn\'t GitHub is refused', write.stdout)
    const direct = await sh('a', 'curl -s -m 5 -o /dev/null -w "%{http_code}" telnet://140.82.112.3:22 || echo none')
    check(!/^2|^SSH/.test(direct.stdout.trim()), 'no other port leaves (enableInternet false)', direct.stdout)
  }

  if (pick.has('sync')) {
    await session('x', 'workspace.execute', { id: 'w-' + run, name: 'write', arguments: { path: '/workspace/notes/' + run + '.txt', content: 'from the workspace ' + run + '\n' } })
    const r = await sh('a', 'cat notes/' + run + '.txt && echo made-' + run + ' > made-' + run + '.txt && rm -f notes/' + run + '.txt')
    check(r.stdout.includes('from the workspace ' + run), 'a workspace file is in the sandbox before the command', r.stdout)
    const now = await files()
    check((await read('/workspace/made-' + run + '.txt'))?.includes('made-' + run), 'a file the command made is in the workspace after it', now)
    check(!now.includes('/workspace/notes/' + run + '.txt'), 'a file the command removed is gone from the workspace', now)
    check(!now.some((path) => path.includes('node_modules')), "node_modules stays in the sandbox, out of the workspace", now.filter((path) => path.includes('node_modules')).slice(0, 3))
  }

  if (pick.has('threads')) {
    const r = await sh('b', 'ls; ls node_modules 2>/dev/null | head -1; echo done')
    check(r.started && r.stdout.includes('made-' + run + '.txt') && !r.stdout.includes('is-number'), "another thread's own container: the seat's workspace, not the other's node_modules", { started: r.started, stdout: r.stdout })
  }

  if (pick.has('restart')) {
    await sh('a', 'echo before > restart-' + run + '.txt')
    await session('a', 'sandboxReset')
    const r = await sh('a', 'cat restart-' + run + '.txt; ls node_modules 2>/dev/null | head -1; echo done')
    check(r.started && r.stdout.startsWith('before') && !r.stdout.includes('is-number'), 'a container that was gone starts again, with the workspace and nothing else', { started: r.started, pushed: r.pushed, stdout: r.stdout })
  }

  if (pick.has('github')) {
    // A public repository: GitHub reads go through the egress like any other.
    const r = await sh('a', 'rm -rf hello && git clone -q --depth 1 https://github.com/octocat/Hello-World hello && git -C hello log --oneline -1 && cat hello/README')
    check(r.exitCode === 0 && r.stdout.includes('Hello World'), 'git clone of a public GitHub repository through the egress', r.stdout + r.stderr)
    check((await files()).includes('/workspace/hello/README'), 'and the clone is in the workspace after it, its .git with it', (await files()).filter((path) => path.startsWith('/workspace/hello/')).slice(0, 5))
    if (!privateRepo) console.log("skip the private clone: name a private repository the Workbus GitHub App is installed on in GITHUB_REPO (owner/name), once its secrets (WORKBUS_GITHUB_APP_ID, WORKBUS_GITHUB_APP_KEY) are in the Secrets Store")
    else {
      const name = privateRepo.split('/')[1]
      const p = await sh('a', 'rm -rf ' + name + ' && git clone -q --depth 1 https://github.com/' + privateRepo + ' ' + name + ' && git -C ' + name + ' log --oneline -1 && grep -c . ' + name + '/.git/config')
      check(p.exitCode === 0 && !/x-access-token|ghs_/.test(p.stdout + p.stderr), 'git clone of a private repository: the egress adds the App\'s token, and nothing in the sandbox holds it', p.stdout + p.stderr)
      const config = await read('/workspace/' + name + '/.git/config')
      check(config !== null && !/ghs_|x-access-token/.test(config), "the clone's .git/config carries no token", config?.slice(0, 200))
    }
  }

} finally {
  for (const thread of threads) await session(thread, 'sandboxReset').catch((error) => console.log('     tearing down ' + thread + ' failed: ' + error.message))
  console.log('     the containers of threads ' + threads.join(', ') + ' are torn down')
}

if (failures) {
  console.log(failures + ' failed')
  process.exit(1)
}
console.log('all passed')

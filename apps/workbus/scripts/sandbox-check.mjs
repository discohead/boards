// The sandbox tier (design/workbus.md §5.4) on vite dev with Docker: a session's container has
// node, npm, git, and curl; an npm install through the egress works, a host the egress refuses
// answers 403; the seat's workspace goes in before a command and what the command changes or
// removes comes back (node_modules stays in the container); another thread of the seat gets its own
// container with the same workspace; a container that's gone starts again with the workspace. No model.
//   pnpm dev:bus & pnpm dev   (Docker running: vite dev builds sandbox/Dockerfile)
//   node scripts/sandbox-check.mjs http://127.0.0.1:8831 [tools,egress,sync,threads,restart]
const [app = 'http://127.0.0.1:8831', only = 'tools,egress,sync,threads,restart'] = process.argv.slice(2)
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

if (pick.has('tools')) {
  const r = await sh('a', 'node -v && npm -v && git --version && curl --version | head -1 && pwd')
  check(r.exitCode === 0 && /^v24\./.test(r.stdout) && /git version/.test(r.stdout) && /curl /.test(r.stdout) && r.stdout.trim().endsWith('/workspace'), 'a container with node 24, npm, git, and curl, in /workspace', r.stdout)
}

if (pick.has('egress')) {
  const r = await sh('a', 'npm init -y >/dev/null && npm install is-number@7.0.0 --no-audit --no-fund 2>&1 | tail -2 && node -e "console.log(require(\'is-number\')(7))"')
  check(r.exitCode === 0 && r.stdout.trim().endsWith('true'), 'npm install through the egress (registry.npmjs.org) works', r.stdout + r.stderr)
  const denied = await sh('a', 'curl -s -o /dev/null -w "%{http_code}" https://example.com/')
  check(denied.stdout.trim() === '403', 'a host the egress refuses answers 403', denied.stdout)
  const plain = await sh('a', 'curl -s -o /dev/null -w "%{http_code}" http://example.com/')
  check(plain.stdout.trim() === '403', 'and plain HTTP goes through the egress too', plain.stdout)
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

if (failures) {
  console.log(failures + ' failed')
  process.exit(1)
}
console.log('all passed')

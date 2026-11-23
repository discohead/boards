// The web and sandbox tiers live (phase 3 step 6), as ada: one DM asks for an npm install in her
// sandbox, a web_fetch and a web_search, and GitHub through the egress (a token-bearing clone and
// read, a throwaway branch seat/ada/egress-check pushed and deleted, and a push to main that the
// egress refuses). Each sandbox_exec waits for the principal: this approves the ones ada holds for
// this run, by their text. Calls Haiku.
//   ACCESS_TOKEN=$(cloudflared access token -app=https://workbus.dev) node scripts/tiers-live.mjs
const origin = process.argv[2] ?? 'https://workbus.dev'
// "github" asks for the GitHub step alone.
const only = process.argv[3]
const auth = { 'cf-access-token': process.env.ACCESS_TOKEN, 'content-type': 'application/json' }
const run = Math.random().toString(36).slice(2, 7)
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
async function board(method, path, body) {
  const response = await fetch(origin + '/b/bus' + path, { method, headers: auth, ...(body ? { body: JSON.stringify(body) } : {}) })
  const answer = await response.json()
  if (!response.ok) throw new Error(method + ' ' + path + ': ' + response.status + ' ' + JSON.stringify(answer))
  return answer
}
let failures = 0
const check = (ok, what, detail = '') => {
  if (!ok) failures++
  console.log((ok ? 'ok   ' : 'FAIL ') + what + (detail === '' ? '' : '  ' + JSON.stringify(detail).slice(0, 600)))
}

const npm = 'mkdir -p /workspace/egress-check-' + run + ' && cd /workspace/egress-check-' + run + ' && npm init -y >/dev/null && npm install is-number@7.0.0 --no-audit --no-fund 2>&1 | tail -1 && node -e "console.log(require(\'is-number\')(7))"'
// In /tmp, so the clone isn't synced into the workspace. The push to main is of an orphan commit:
// even if the egress let it through, GitHub would refuse a non-fast-forward push without --force.
// A push to main the egress must refuse: a receive-pack request whose one command moves refs/heads/main
// from an old value that isn't main's, so GitHub itself would refuse it too if it got through.
const toMain = 'echo Y29uc3QgbGluZSA9ICcwJy5yZXBlYXQoMzkpICsgJzEgJyArICcyJy5yZXBlYXQoNDApICsgJyByZWZzL2hlYWRzL21haW5cMHJlcG9ydC1zdGF0dXNcbicKY29uc3QgYm9keSA9IChsaW5lLmxlbmd0aCArIDQpLnRvU3RyaW5nKDE2KS5wYWRTdGFydCg0LCAnMCcpICsgbGluZSArICcwMDAwJwpjb25zdCByID0gYXdhaXQgZmV0Y2goJ2h0dHBzOi8vZ2l0aHViLmNvbS93b3JrYnVzLWRldi93b3JrYnVzL2dpdC1yZWNlaXZlLXBhY2snLCB7IG1ldGhvZDogJ1BPU1QnLCBoZWFkZXJzOiB7ICdjb250ZW50LXR5cGUnOiAnYXBwbGljYXRpb24veC1naXQtcmVjZWl2ZS1wYWNrLXJlcXVlc3QnIH0sIGJvZHkgfSkKY29uc29sZS5sb2coJ01BSU4nLCByLnN0YXR1cywgKGF3YWl0IHIudGV4dCgpKS5zbGljZSgwLCAyMDApKQo= | base64 -d > /tmp/main.mjs && node /tmp/main.mjs'
const github = [
  'cd /tmp && rm -rf wb && git clone -q --depth 1 https://github.com/workbus-dev/workbus wb && cd wb && echo CLONED',
  'curl -s -D - -o /dev/null https://api.github.com/repos/workbus-dev/workbus | grep -i "^x-ratelimit-limit"',
  'git checkout -q -b seat/ada/egress-check && git -c user.name=ada -c user.email=ada@users.noreply.workbus.dev commit -q --allow-empty -m "egress check ' + run + ' (throwaway)"',
  'git push -q origin seat/ada/egress-check && echo PUSHED',
  'git push -q origin --delete seat/ada/egress-check && echo DELETED',
  'git checkout -q --orphan probe && git -c user.name=ada -c user.email=ada@users.noreply.workbus.dev commit -q --allow-empty -m probe && (git push origin probe:refs/heads/main 2>&1 | tail -4; true)',
].join(' && ')
const text = (only === 'main'
  ? ['A GitHub egress check (' + run + '). Do exactly this, then reply here with its output, briefly:', '1. sandbox_exec with this command, as it is: ' + toMain]
  : only === 'github'
  ? ['A GitHub egress check (' + run + '). Do exactly this, then reply here with its output, briefly:', '1. sandbox_exec with this command, as it is: ' + github]
  : [
      'An egress check (' + run + '). Do exactly these, in order, then reply here with each result, briefly:',
      '1. sandbox_exec with this command, as it is: ' + npm,
      '2. web_fetch https://developers.cloudflare.com/containers/ and give its title.',
      '3. web_search "Cloudflare Containers instance types" and give the first result\'s title.',
      '4. sandbox_exec with this command, as it is: ' + github,
    ]
).join('\n')

const started = new Date().toISOString()
const dm = (await board('POST', '/messages', { channel: 'dm/ada', text })).message.id
console.log('     asked ada in dm/ada #' + dm)
const approved = new Set()
let reply = null
for (let i = 0; i < 90 && !reply; i++) {
  await sleep(10_000)
  // Approve ada's held sandbox_exec calls for this run, and only those.
  const held = (await board('GET', '/tasks?state=blocked&limit=100')).tasks.map((t) => t.message).filter((m) => m.createdAt >= started && m.by?.actor === 'worker:workbus-app+ada' && m.text.includes('sandbox_exec') && m.text.includes('in #' + dm + ':'))
  for (const m of held) if (!approved.has(m.id)) {
    await board('POST', '/tasks/' + m.id + '/unblock', { decision: 'approved', note: 'egress check ' + run })
    approved.add(m.id)
    console.log('     approved #' + m.id)
  }
  const thread = await board('GET', '/messages/' + dm)
  reply = thread.replies.filter((m) => m.by?.actor === 'worker:workbus-app+ada').find((m) => /DELETED|403|main/i.test(m.text)) ?? null
}
check(approved.size >= (only ? 1 : 2), 'each sandbox_exec call waited for the principal, and ran once approved', [...approved])
const status = await (await fetch(origin + '/api/seats/ada', { headers: auth })).json()
const runs = status.runs.filter((r) => r.ended >= started)
const tools = runs.flatMap((r) => r.tools)
console.log('     tools: ' + JSON.stringify(tools))
console.log('     reply: ' + (reply?.text ?? '(none)').replace(/\n/g, ' | ').slice(0, 1500))
check(tools.some((t) => t.name === 'sandbox_exec' && t.ok), 'sandbox_exec ran', tools.filter((t) => t.name.startsWith('sandbox')))
if (!only) check(tools.some((t) => t.name === 'web_fetch' && t.ok) && tools.some((t) => t.name === 'web_search' && t.ok), 'web_fetch and web_search ran')
check(tools.some((t) => t.name === 'sandbox:basic'), "the run records carry the container's time", tools.filter((t) => t.name === 'sandbox:basic'))
const workspace = only ? { text: 'is-number (skipped)' } : await (await fetch(origin + '/api/seats/ada?file=' + encodeURIComponent('/workspace/egress-check-' + run + '/package.json'), { headers: auth })).json()
check(!workspace.error && workspace.text.includes('is-number'), "npm install's package.json came back to ada's workspace", workspace.text?.slice(0, 120))
console.log('     spend: ' + JSON.stringify(status.spend))
if (failures) {
  console.log(failures + ' failed')
  process.exit(1)
}
console.log('all passed')

// An agent's work loop over the board's HTTP API, with no dependencies: wait for a ready task in a
// channel, claim it, keep its lease while it works, say what it's doing in the task's thread, and
// complete or fail it. Run as many as you like: each task goes to exactly one of them.
//   WORKBUS_URL=https://<your worker>/b/<board> WORKBUS_TOKEN=<token> node agent.mjs uptime/
const BOARD = process.env.WORKBUS_URL
const TOKEN = process.env.WORKBUS_TOKEN
const CHANNEL = process.argv[2] ?? 'uptime/'
const LEASE = 60 // seconds: the claim lapses this long after the last renew, and the task is ready again

/** One protocol call: its answer, or an Error that leads with the board's code. */
async function call(method, path, body) {
  const response = await fetch(BOARD + path, {
    method,
    headers: { authorization: 'Bearer ' + TOKEN, 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  const answer = await response.json()
  if (!response.ok) throw new Error(answer.error.code + ': ' + answer.error.message)
  return answer
}

/** The work itself. Here: check that the URL a task names answers. Yours goes here. */
async function work(task) {
  const target = task.text.match(/https?:\/\/\S+/)?.[0]
  if (!target) throw new Error('the task names no URL')
  const response = await fetch(target, { signal: AbortSignal.timeout(10_000) })
  return target + ' answered ' + response.status
}

for (;;) {
  // Held by the board until a task is ready (up to 60 s), then claimed in the same transaction.
  const { task, claim } = await call('POST', '/tasks/claim', { channel: CHANNEL, lease: LEASE, wait: 60 })
  if (!task) continue
  // Every write on the claim carries its epoch and token: once the claim lapses, they're refused.
  const fenced = { epoch: claim.epoch, token: claim.token }
  const renewing = setInterval(() => call('POST', '/tasks/' + task.id + '/renew', { ...fenced, lease: LEASE }).catch(() => {}), (LEASE / 2) * 1000)
  try {
    await call('POST', '/messages', { re: task.id, text: 'On it.' })
    const result = await work(task)
    await call('POST', '/tasks/' + task.id + '/complete', { ...fenced, result })
    console.log('#' + task.id + '  completed  ' + result)
  } catch (error) {
    const reason = error.cause?.code ?? error.message
    await call('POST', '/tasks/' + task.id + '/fail', { ...fenced, reason }).catch(() => {})
    console.log('#' + task.id + '  failed     ' + reason)
  } finally {
    clearInterval(renewing)
  }
}

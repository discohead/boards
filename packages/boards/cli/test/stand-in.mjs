// A stand-in board for the routes the dev server doesn't serve yet (tasks, schedules, files,
// grants), answering with the shapes the protocol reference gives, and keeping every request it
// got so a test can check what the CLI sent. It is the reference's contract, not a board.
import { createServer } from 'node:http'

export const TOKEN = 'stand-in-token'

export async function standIn() {
  const requests = []
  const tasks = new Map()
  const schedules = new Map()
  const files = new Map()
  const grants = new Map([['g1', { id: 'g1', principals: [{ kind: 'all-users' }], can: { '*': 'all' }, capped: false, by: null, at: null }]])
  let next = 10
  let grantNext = 4
  const now = () => new Date().toISOString()

  const view = (task) => ({
    id: task.id, channel: task.channel, text: task.text, re: null, replyTo: null, thread: 't' + task.id, labels: { ...task.labels, 'board.task': task.state }, reactions: {},
    by: { actor: 'boards:user:tester', principal: 'boards:user:tester', profile: null }, author: { kind: 'person', handle: 'tester', name: 'tester', avatar: null },
    noSync: false, origin: null, from: null, createdAt: task.createdAt, editedAt: null, deleted: false, undelivered: {}, attachments: [], links: [], blocks: [], version: 1, revision: 1,
    task: { state: task.state, owner: 'boards:user:tester', by: 'boards:user:tester', for: null, needs: task.needs, epoch: task.epoch, claim: task.claim ? { actor: task.claim.actor, until: task.claim.until } : null, blocked: task.blocked, result: task.result, reason: task.reason },
  })
  const claimOf = (task, token, lease = 900, actor = 'boards:user:tester') => {
    task.epoch += 1
    task.state = 'claimed'
    task.claim = { actor, until: new Date(Date.now() + lease * 1000).toISOString(), token }
    return { epoch: task.epoch, token, until: task.claim.until }
  }
  const fenced = (task, body) => task.state === 'claimed' && task.epoch === body.epoch && task.claim?.token === body.token

  const routes = [
    ['GET', /^\/me$/, () => [200, { actor: 'boards:user:tester', principal: 'boards:user:tester', kind: 'person', handle: 'tester', name: 'tester', avatar: null, profile: null, expiresAt: null, can: { '*': ['read', 'post', 'react', 'label', 'sync', 'manage'] } }]],
    ['POST', /^\/tasks$/, (body) => {
      const task = { id: String(next++), channel: body.channel, text: body.text, labels: body.labels ?? {}, needs: body.needs ?? [], state: body.needs?.length ? 'waiting' : 'ready', epoch: 0, claim: null, blocked: null, result: null, reason: null, createdAt: now() }
      tasks.set(task.id, task)
      const claim = body.claim ? claimOf(task, body.token, body.lease) : undefined
      return [201, { task: view(task), ...(claim ? { claim } : {}) }]
    }],
    ['GET', /^\/tasks$/, (_body, _m, query) => {
      const state = query.get('state') ?? 'open'
      const open = ['waiting', 'ready', 'claimed', 'blocked']
      const list = [...tasks.values()].filter((task) => (state === 'all' ? true : state === 'open' ? open.includes(task.state) : task.state === state)).filter((task) => !query.get('channel') || task.channel === query.get('channel'))
      return [200, { tasks: list.map((task) => ({ message: view(task), replies: 0, last: null })), cursor: String(next) }]
    }],
    ['POST', /^\/tasks\/claim$/, (body) => {
      const task = [...tasks.values()].find((t) => t.state === 'ready' && (t.channel === body.channel || (body.channel.endsWith('/') && t.channel.startsWith(body.channel))))
      if (!task) return [200, { task: null }]
      const claim = claimOf(task, body.token, body.lease)
      return [200, { task: view(task), claim }]
    }],
    ['POST', /^\/tasks\/([^/]+)\/(claim|renew|release|complete|fail|block|unblock|reopen|cancel|assign|needs)$/, (body, [, id, verb]) => {
      const task = tasks.get(decodeURIComponent(id))
      if (!task) return [404, { error: { code: 'message_not_found', message: 'message not found: #' + id } }]
      const lost = [409, { error: { code: 'claim_lost', message: 'this claim on #' + id + ' is over: claim it again' } }]
      switch (verb) {
        case 'claim':
          if (task.state !== 'ready') return [409, { error: { code: 'task_claimed', message: '#' + id + ' is claimed until ' + task.claim?.until } }]
          return [200, { task: view(task), claim: claimOf(task, body.token, body.lease) }]
        case 'renew':
          if (!fenced(task, body)) return lost
          task.claim.until = new Date(Date.now() + (body.lease ?? 900) * 1000).toISOString()
          return [200, { task: view(task), until: task.claim.until }]
        case 'release':
          if (!fenced(task, body)) return lost
          Object.assign(task, { state: 'ready', claim: null })
          return [200, { task: view(task) }]
        case 'complete':
          if (!fenced(task, body)) return lost
          Object.assign(task, { state: 'completed', claim: null, result: body.result ?? null })
          return [200, { task: view(task) }]
        case 'fail':
          if (!fenced(task, body)) return lost
          Object.assign(task, { state: 'failed', claim: null, reason: body.reason })
          return [200, { task: view(task) }]
        case 'block':
          if (body.epoch !== undefined && !fenced(task, body)) return lost
          Object.assign(task, { state: 'blocked', claim: null, blocked: { kind: body.kind ?? null, reason: body.reason } })
          return [200, { task: view(task) }]
        case 'unblock':
          Object.assign(task, { state: 'ready', blocked: null })
          return [200, { task: view(task) }]
        case 'reopen':
          Object.assign(task, { state: 'ready', reason: null })
          return [200, { task: view(task) }]
        case 'cancel':
          Object.assign(task, { state: 'canceled', claim: null, reason: body.reason })
          return [200, { task: view(task) }]
        case 'assign':
          return [200, { task: { ...view(task), task: { ...view(task).task, for: body.for } } }]
        case 'needs':
          task.needs = body.needs
          return [200, { task: view(task) }]
      }
    }],
    ['POST', /^\/schedules$/, (body) => {
      const id = 's' + next++
      const every = body.every ? Number.parseFloat(body.every) * { s: 1e3, m: 6e4, h: 36e5, d: 864e5 }[body.every.at(-1)] : null
      const first = body.at ?? new Date(Date.now() + (every ?? 600_000)).toISOString()
      const schedule = { id, channel: body.channel ?? 'general', re: body.re ?? null, text: body.text, labels: body.labels ?? {}, noSync: false, attachments: [], first, every, until: body.until ?? null, times: body.times ?? null, sent: 0, next: first, last: null, state: 'pending', canceled: null, by: { actor: 'boards:user:tester', principal: 'boards:user:tester', profile: null }, author: { kind: 'person', handle: 'tester', name: 'tester', avatar: null }, createdAt: now() }
      schedules.set(id, schedule)
      return [201, { schedule }]
    }],
    ['GET', /^\/schedules$/, (_b, _m, query) => [200, { schedules: [...schedules.values()].filter((s) => query.get('all') === 'true' || s.state === 'pending') }]],
    ['POST', /^\/schedules\/([^/]+)\/cancel$/, (_b, [, id]) => {
      const schedule = schedules.get(id)
      if (!schedule) return [404, { error: { code: 'schedule_not_found', message: 'schedule not found: ' + id } }]
      const canceled = schedule.state === 'pending'
      if (canceled) Object.assign(schedule, { state: 'canceled', next: null, canceled: { by: schedule.by, reason: 'canceled' } })
      return [200, { schedule, canceled }]
    }],
    ['GET', /^\/grants$/, () => [200, { grants: [...grants.values()] }]],
    ['POST', /^\/grants$/, (body) => {
      const grant = { id: 'g' + grantNext++, principals: body.principals.map((p) => (p.kind === 'user' ? { kind: 'user', userId: p.userId ?? p.email, email: p.email ?? null } : p.kind === 'github' ? { ...p, repositoryId: null } : p)), can: body.can, capped: false, by: 'boards:user:tester', at: now() }
      grants.set(grant.id, grant)
      return [200, { grant }]
    }],
    ['POST', /^\/grants\/([^/]+)\/revoke$/, (_b, [, id]) => [200, { revoked: grants.delete(id) }]],
  ]

  const server = createServer(async (req, res) => {
    const chunks = []
    for await (const chunk of req) chunks.push(chunk)
    const raw = Buffer.concat(chunks)
    const url = new URL(req.url, 'http://stand-in')
    const path = url.pathname.replace(/^\/b\/ref/, '') || '/'
    const record = { method: req.method, path, query: Object.fromEntries(url.searchParams), headers: req.headers, raw, body: null }
    requests.push(record)
    const send = (status, value, headers = { 'content-type': 'application/json' }) => {
      res.writeHead(status, headers)
      res.end(Buffer.isBuffer(value) ? value : JSON.stringify(value))
    }
    if (req.headers.authorization !== 'Bearer ' + TOKEN) return send(401, { error: { code: 'unauthorized', message: 'missing bearer token' } })
    if (req.method === 'POST' && path === '/attachments') {
      const id = 'A'.repeat(11) + String(next++).padStart(11, '0')
      const attachment = { id, name: decodeURIComponent(req.headers['x-board-filename'] ?? 'file'), type: req.headers['content-type'] ?? 'application/octet-stream', size: raw.length }
      files.set(id, { attachment, raw })
      return send(201, { attachment })
    }
    if (req.method === 'GET' && path.startsWith('/attachments/')) {
      const file = files.get(decodeURIComponent(path.slice('/attachments/'.length)))
      if (!file) return send(404, { error: { code: 'attachment_not_found', message: 'no attachment' } })
      return send(200, file.raw, { 'content-type': file.attachment.type, 'content-length': String(file.attachment.size), 'content-disposition': "attachment; filename*=UTF-8''" + encodeURIComponent(file.attachment.name) })
    }
    if (raw.length) {
      try {
        record.body = JSON.parse(raw.toString('utf8'))
      } catch {
        return send(400, { error: { code: 'invalid_request', message: 'request body is not valid JSON' } })
      }
    }
    for (const [method, pattern, handle] of routes) {
      const found = req.method === method && pattern.exec(path)
      if (found) {
        const [status, value] = handle(record.body ?? {}, found, url.searchParams)
        return send(status, value)
      }
    }
    send(404, { error: { code: 'not_found', message: 'no route: ' + req.method + ' ' + url.pathname } })
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  return {
    url: 'http://127.0.0.1:' + server.address().port + '/b/ref',
    requests,
    tasks,
    last: (method, path) => [...requests].reverse().find((r) => r.method === method && (typeof path === 'string' ? r.path === path : path.test(r.path))),
    close: () => new Promise((resolve) => (server.closeAllConnections(), server.close(resolve))),
  }
}

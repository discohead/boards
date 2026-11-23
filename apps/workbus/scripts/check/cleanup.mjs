// What a live check made, taken away again (#26): the threads it started or that carry its run id,
// every message in them (each as its author where the check holds that credential, else as the
// owner, by moderation), the channels only checks use (archived, #15), and the actors and profiles
// it made (hidden, #16). What it can't take away it lists, with why, rather than leaving it quietly;
// and it looks again afterwards, so anything it missed is listed too.
//
//   const clean = cleaner({ owner, others: [other] })
//   clean.marker(run); clean.channel('checks/x'); clean.since('checks/x'); clean.track(id); clean.profile(owner.actor + '+reviewer')
//   await clean.prepare()          // unarchives the tracked channels, so the check can post in them
//   … the check …
//   const { left } = await clean.finish()   // prints what it did and what it couldn't

/** The routes the clean-up uses beyond delete, by operationId in the board's OpenAPI: POST /channels/archive
 * and /channels/unarchive { path } (#15), and POST /actors/hide { actor, hidden } (#16). */
export const ROUTES = { archive: 'archiveChannel', unarchive: 'unarchiveChannel', hide: 'hideActor' }

/** The board's routes by operationId: { route, method }. */
async function routesOf(client) {
  const spec = await client.get('/openapi.json')
  const out = new Map()
  for (const [route, methods] of Object.entries(spec.paths ?? {})) for (const [method, op] of Object.entries(methods)) if (op?.operationId) out.set(op.operationId, { route, method: method.toUpperCase() })
  return out
}

/** A client over a board's HTTP API, for a check that has only its headers: { actor (after whoami), get, post }. */
export function busClient(board, headers) {
  const call = async (method, path, body) => {
    const response = await fetch(board + path, { method, headers: { ...headers, ...(body !== undefined ? { 'content-type': 'application/json' } : {}) }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) })
    const text = await response.text()
    if (!response.ok) throw new Error(method + ' ' + path + ' answered ' + response.status + ': ' + text.slice(0, 200))
    return text ? JSON.parse(text) : null
  }
  const client = {
    actor: null,
    async whoami() {
      client.actor ??= (await call('GET', '/me')).actor
      return client.actor
    },
    get: (path) => call('GET', path),
    post: (path, body) => call('POST', path, body ?? {}),
  }
  return client
}

/** The routes whose answer is a thing a check made: what note() keeps. */
const MAKERS = new Set(['/messages', '/tasks', '/tasks/batch', '/docs'])

const short = (id) => id.replace(/(access:user:)[0-9a-f-]{8,}/, '$1<sub>')

export function cleaner({ owner, others = [], log = (line) => console.log(line), started = new Date().toISOString() }) {
  const tracked = new Set()
  /** Principal messages that start work: seats stamp what they make for it with org.request (seats/request.ts). */
  const requests = new Set()
  const markers = new Set()
  const channels = new Set()
  const profiles = new Set()
  /** Channels whose every thread from a moment on is the check's: path → ISO time. */
  const since = new Map()
  const clients = [owner, ...others]
  /** The client that wrote a message: its principal's, if the check holds it. */
  const authorOf = (message) => clients.find((client) => client.actor === message.by.principal || client.actor === message.by.actor)

  /** One message by ID: GET /messages/:id answers a reply's whole thread, so a reply is found in it. */
  async function messageOf(id) {
    const read = await owner.get('/messages/' + id + '?limit=500').catch(() => null)
    if (!read) return null
    return read.message.id === id ? read.message : (read.replies.find((reply) => reply.id === id) ?? null)
  }

  /** Every live thread root that's the check's: tracked, carrying a marker, or new in a check-only channel. */
  async function discover() {
    const found = new Set(tracked)
    const pages = async (query, keep) => {
      for (let before = null; ; ) {
        const page = await owner.get('/threads?limit=500&' + query + (before ? '&before=' + encodeURIComponent(before) : ''))
        for (const entry of page.threads) if (!entry.message.deleted && keep(entry.message)) found.add(entry.message.id)
        if (!page.older || page.threads.length === 0) break
        before = page.older
      }
    }
    // What seats made in answer carries the run id, or its request's label, wherever they put it. Only
    // what's new since the check started: a doc that was there before is never the check's.
    const fresh = (message) => message.createdAt >= started
    for (const marker of markers) await pages('text=' + encodeURIComponent(marker), fresh)
    for (const request of requests) await pages('label=' + encodeURIComponent('org.request=' + request), fresh)
    for (const [path, at] of since) await pages('channel=' + encodeURIComponent(path), (message) => message.createdAt >= at)
    const live = new Set()
    for (const id of found) {
      const one = await messageOf(id)
      if (one && !one.deleted) live.add(id)
    }
    return live
  }

  return {
    track: (id) => tracked.add(String(id)),
    request: (id) => requests.add(String(id)),
    /**
     * Keeps what a write made, from its answer: a post, a reply (the reply alone, never the thread it's
     * in), a task, a doc, a proposal. A post of the principal's starts a request (request: true).
     */
    note(path, answer, { request = false } = {}) {
      if (!MAKERS.has(path) || !answer) return answer
      const made = [answer.message, answer.task, answer.proposal, ...(answer.tasks ?? [])].filter(Boolean)
      for (const one of made) if (one.id) tracked.add(String(one.id))
      if (request && answer.message && !answer.message.re) requests.add(String(answer.message.id))
      return answer
    },
    marker: (text) => markers.add(text),
    channel: (path) => channels.add(path),
    profile: (id) => profiles.add(id),
    /** Every thread in a check-only channel from this moment on is the check's (a row whose text lacks the run id). */
    since: (path, at = new Date().toISOString()) => since.set(path, at),

    /** Unarchives the tracked channels, where archiving is live, so the check can post in them. */
    async prepare() {
      const route = (await routesOf(owner)).get(ROUTES.unarchive)
      if (!route) return
      for (const path of channels) await owner.post(route.route, { path }).catch(() => {})
    },

    /** Deletes, archives, and hides what the check made; returns (and prints) what it couldn't. */
    async finish() {
      const left = []
      for (const client of clients) await client.whoami?.()
      const threads = await discover()
      let messages = 0
      for (const id of threads) {
        const read = await owner.get('/messages/' + id + '?limit=500').catch(() => null)
        if (!read) continue
        // A thread goes away whole: replies first, newest first, then the root. A reply the check made
        // in someone else's thread goes alone.
        const own = read.message.id === id ? [...read.replies].reverse().concat([read.message]) : read.replies.filter((reply) => reply.id === id)
        for (const message of own) {
          if (message.deleted) continue
          const by = authorOf(message)
          try {
            await (by ?? owner).post('/messages/' + message.id + '/delete', {})
            messages++
          } catch (error) {
            left.push({ what: '#' + message.id + (message.id === id ? '' : ' in #' + id) + ' by ' + (message.author?.handle ?? short(message.by.actor)), why: (by ? '' : "needs the owner's moderation (#26): ") + String(error.message).slice(0, 140) })
          }
        }
      }
      // Look again: anything still live is listed, whatever the reason.
      const still = await discover()
      for (const id of still) if (!left.some((item) => item.what.startsWith('#' + id))) left.push({ what: '#' + id, why: 'still there after the clean-up' })
      const routes = channels.size || profiles.size ? await routesOf(owner) : new Map()
      let archived = 0
      for (const path of channels) {
        const route = routes.get(ROUTES.archive)
        if (!route) {
          left.push({ what: 'channel ' + path, why: 'archiving a channel needs #15' })
          continue
        }
        try {
          await owner.post(route.route, { path })
          archived++
        } catch (error) {
          left.push({ what: 'channel ' + path, why: String(error.message).slice(0, 160) })
        }
      }
      let hidden = 0
      for (const id of profiles) {
        const route = routes.get(ROUTES.hide)
        if (!route) {
          left.push({ what: 'actor ' + short(id), why: 'hiding an actor needs #16' })
          continue
        }
        try {
          await owner.post(route.route, { actor: id, hidden: true })
          hidden++
        } catch (error) {
          left.push({ what: 'actor ' + short(id), why: String(error.message).slice(0, 160) })
        }
      }
      const deleted = threads.size - still.size
      log('cleanup: ' + deleted + ' of ' + threads.size + ' threads deleted (' + messages + ' messages), ' + archived + ' of ' + channels.size + ' channels archived, ' + hidden + ' of ' + profiles.size + ' actors hidden' + (left.length ? '; left ' + left.length + ':' : ''))
      for (const item of left) log('  left ' + item.what + ': ' + item.why)
      return { deleted, messages, archived, hidden, threads: threads.size, left }
    },
  }
}

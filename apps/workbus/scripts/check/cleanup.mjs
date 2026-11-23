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

const short = (id) => id.replace(/(access:user:)[0-9a-f-]{8,}/, '$1<sub>')

export function cleaner({ owner, others = [], log = (line) => console.log(line) }) {
  const tracked = new Set()
  const markers = new Set()
  const channels = new Set()
  const profiles = new Set()
  /** Channels whose every thread from a moment on is the check's: path → ISO time. */
  const since = new Map()
  const clients = [owner, ...others]
  /** The client that wrote a message: its principal's, if the check holds it. */
  const authorOf = (message) => clients.find((client) => client.actor === message.by.principal || client.actor === message.by.actor)

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
    // What seats made in answer carries the run id too, wherever they put it.
    for (const marker of markers) await pages('text=' + encodeURIComponent(marker), () => true)
    for (const [path, at] of since) await pages('channel=' + encodeURIComponent(path), (message) => message.createdAt >= at)
    const live = new Set()
    for (const id of found) {
      const read = await owner.get('/messages/' + id + '?limit=1').catch(() => null)
      if (read && !read.message.deleted) live.add(id)
    }
    return live
  }

  return {
    track: (id) => tracked.add(String(id)),
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
      const threads = await discover()
      let messages = 0
      for (const id of threads) {
        const read = await owner.get('/messages/' + id + '?limit=500').catch(() => null)
        if (!read) continue
        // Replies first, newest first, then the root: a thread goes away whole.
        for (const message of [...read.replies].reverse().concat([read.message])) {
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

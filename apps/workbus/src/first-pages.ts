// The first pages, read on the server for a page's first paint (design/workbus.md §9.2), as the
// person: the BUS binding carries their Access assertion to the bus, which verifies it itself. In
// wrangler dev, where there's no Access, a board token in .dev.vars (WORKBUS_DEV_TOKEN) stands in,
// and the page gets it too, for its own reads and the feed.
import { createServerFn } from '@tanstack/react-start'
import { getRequestHeader } from '@tanstack/react-start/server'
import { env } from 'cloudflare:workers'
import { createRuntime, readFirstPages } from './data/index.ts'
import { BOARD } from './board.ts'

/** Where the bus is, to a request through the BUS binding: the host is the bus's own (BOARD_ORIGIN), not this one. */
const BUS_URL = 'https://bus.internal/b/' + BOARD

export const firstPages = createServerFn()
  .validator((input: { channel?: string }) => ({ ...(typeof input.channel === 'string' && input.channel.length <= 500 ? { channel: input.channel } : {}) }))
  .handler(async ({ data }) => {
  const assertion = getRequestHeader('cf-access-jwt-assertion')
  const token = import.meta.env.DEV ? env.WORKBUS_DEV_TOKEN : undefined
  const forwarded = (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input, init)
    if (assertion) request.headers.set('cf-access-jwt-assertion', assertion)
    return env.BUS.fetch(request)
  }
  // The state goes as JSON text: its rows are the board's own JSON.
  if (!assertion && !token) return { state: null as string | null, me: null as string | null, late: false, token: null as string | null }
  const runtime = createRuntime('server', { url: BUS_URL, fetch: forwarded as typeof fetch, ...(token ? { token } : {}) })
  const { state, me, late } = await readFirstPages(runtime, data)
  return { state: JSON.stringify(state) as string | null, me: me ? (JSON.stringify(me) as string | null) : null, late, token: token ?? null }
})

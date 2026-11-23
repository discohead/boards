// The web tier (design/workbus.md §5.4): web_fetch and web_search, behind the seam.
// - web_fetch reads one URL through the seat's egress (GET only, public hosts, logged), as Markdown
//   for HTML and documents (Workers AI's toMarkdown), JSON, or text, a window at a time. A page the
//   plain fetch can't read (a bot challenge, or HTML that is empty until scripts run) is read again
//   with Browser Run, logged the same way.
// - web_search runs Cloudflare's Web Search API through the gateway, on the provider key stored on it.
// Both are the Agents SDK's own (agents/webfetch, agents/websearch), put behind the seam.
import { createDirectWebFetch, isPrivateOrLocalHost, renderWebFetchPage, WebFetchError, windowWebFetchPage, WEB_FETCH_TOOL_DESCRIPTION, type WebFetchPage } from 'agents/webfetch'
import { createAIWebSearch, renderWebSearchResults, WebSearchError, WEB_SEARCH_TOOL_DESCRIPTION } from 'agents/websearch'
import { z } from 'zod'

import { logEgress } from '../egress/egress.ts'
import type { Tool } from './types.ts'

export const SEARCH_PROVIDER = 'ceramic'
export const SEARCH_ALIAS = 'workbus-ceramic'

/** Browser Run's markdown quick action, as the BROWSER binding has it. */
type QuickActions = { quickAction(action: 'markdown', input: { url: string }): Promise<Response> }

export type WebDeps = {
  seat: string
  /** The seat's egress, in web mode: every plain fetch goes through it. */
  egress: { fetch(input: RequestInfo, init?: RequestInit): Promise<Response> }
  ai: Ai
  browser?: QuickActions
  gateway: string
}

/** HTML whose converted text is this short is taken for a page that needs scripts to show anything. */
const THIN_HTML = 200

/** Read a page through Browser Run, under the same URL rule as the egress (public http(s) only). */
async function viaBrowser(deps: WebDeps, url: string): Promise<WebFetchPage | null> {
  if (!deps.browser) return null
  const parsed = new URL(url)
  if ((parsed.protocol !== 'https:' && parsed.protocol !== 'http:') || isPrivateOrLocalHost(parsed.hostname)) return null
  const started = Date.now()
  const response = await deps.browser.quickAction('markdown', { url })
  const body = (await response.json().catch(() => null)) as { success?: boolean; result?: string } | null
  const content = body?.success ? String(body.result ?? '') : ''
  logEgress({ egress: 1, seat: deps.seat, mode: 'browser', method: 'GET', host: parsed.hostname, path: parsed.pathname.slice(0, 200), status: response.status, bytes: content.length, ms: Date.now() - started, credential: null, ...(body?.success ? {} : { refused: 'browser: ' + response.status }) })
  if (!body?.success) return null
  return { url, finalUrl: url, status: 200, contentType: 'text/markdown', via: 'converted', content, totalChars: content.length, headers: {}, bytes: content.length, redirects: [] }
}

const FetchInput = z.object({
  url: z.string().min(1).max(2000),
  offset: z.number().int().min(0).optional(),
  format: z.enum(['auto', 'raw']).optional(),
})

const SearchInput = z.object({
  query: z.string().min(1).max(400),
  limit: z.number().int().min(1).max(10).optional(),
})

export function webTools(deps: WebDeps): Tool<any>[] {
  const direct = createDirectWebFetch({
    binding: deps.ai,
    fetch: ((input: RequestInfo, init?: RequestInit) => deps.egress.fetch(input, init)) as typeof fetch,
  })
  const search = createAIWebSearch({ binding: deps.ai, gateway: deps.gateway, provider: SEARCH_PROVIDER, byokAlias: SEARCH_ALIAS })

  const webFetch: Tool<z.infer<typeof FetchInput>> = {
    name: 'web_fetch',
    description: WEB_FETCH_TOOL_DESCRIPTION,
    input: FetchInput,
    replay: 'safe',
    approval: 'never',
    async run(input, context) {
      let page: WebFetchPage | null = null
      try {
        page = await direct.fetch({ url: input.url, format: input.format }, { signal: context.signal })
        const thin = page.contentType === 'text/html' && page.via === 'converted' && page.content.trim().length < THIN_HTML
        if (thin && input.format !== 'raw') page = (await viaBrowser(deps, page.finalUrl).catch(() => null)) ?? page
      } catch (error) {
        const blocked = error instanceof WebFetchError && error.code === 'web_fetch_blocked'
        if (blocked) page = await viaBrowser(deps, input.url).catch(() => null)
        if (!page) return { text: error instanceof Error ? error.message : String(error), isError: true }
      }
      return { text: renderWebFetchPage(windowWebFetchPage(page, { offset: input.offset ?? 0 })) }
    },
  }

  const webSearch: Tool<z.infer<typeof SearchInput>> = {
    name: 'web_search',
    description: WEB_SEARCH_TOOL_DESCRIPTION,
    input: SearchInput,
    // A search interrupted mid-call costs a second search when it runs again; that's fine.
    replay: 'safe',
    approval: 'never',
    async run(input, context) {
      try {
        const started = Date.now()
        const response = await search.search({ query: input.query, limit: input.limit ?? 5 }, { signal: context.signal })
        // The binding's search takes no gateway metadata, so the seat is on this line instead.
        logEgress({ egress: 1, seat: deps.seat, mode: 'search', method: 'POST', host: 'websearch:' + SEARCH_PROVIDER, path: '/' + (response.metadata?.requestId ?? ''), status: 200, bytes: response.items.length, ms: Date.now() - started, credential: null })
        return { text: renderWebSearchResults(response, { maxDescriptionChars: 600 }) }
      } catch (error) {
        return { text: error instanceof WebSearchError || error instanceof Error ? error.message : String(error), isError: true }
      }
    },
  }

  return [webFetch, webSearch]
}

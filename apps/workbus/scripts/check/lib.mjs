// The check suite's harness: a browser signed in as the board's owner, two actors writing over the
// bus's HTTP API (the owner, and someone else), and steps that print pass/fail and save a
// screenshot each. Areas (areas/*.mjs) export run(t), where t is what this file makes.
import { mkdirSync } from 'node:fs'
import { chromium } from 'playwright-core'

/** One actor on the bus: GET/POST with its credential, and who it is (GET /me). */
export async function actor(name, { api, headers }) {
  const call = async (method, path, body, extra = {}) => {
    const response = await fetch(api + path, { method, headers: { ...headers, ...extra, ...(body !== undefined ? { 'content-type': 'application/json' } : {}) }, body: body !== undefined ? JSON.stringify(body) : undefined })
    const text = await response.text()
    let json = null
    try {
      json = text ? JSON.parse(text) : null
    } catch {}
    if (!response.ok) throw new Error(name + ' ' + method + ' ' + path + ' answered ' + response.status + ': ' + text.slice(0, 300))
    return json
  }
  const me = await call('GET', '/me')
  return { name, api, me, actor: me.actor, handle: me.handle, get: (path) => call('GET', path), post: (path, body, extra) => call('POST', path, body ?? {}, extra) }
}

/** A Chromium page on the app: the cached Chromium (playwright-core never downloads), or --chrome <path>. */
export async function browser({ base, chrome, accessToken, width = 1440, height = 900 }) {
  const instance = await chromium.launch({ headless: true, ...(chrome ? { executablePath: chrome } : {}) })
  const context = await instance.newContext({ viewport: { width, height }, ...(accessToken ? { extraHTTPHeaders: { 'cf-access-token': accessToken } } : {}) })
  if (accessToken) await context.addCookies([{ name: 'CF_Authorization', value: accessToken, url: base }])
  const page = await context.newPage()
  // A step waits this long for an element it acts on; one that isn't there fails the step, not the run.
  page.setDefaultTimeout(10_000)
  const errors = []
  page.on('pageerror', (error) => errors.push(error.message))
  return { instance, context, page, errors }
}

const slug = (text) => text.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 60)

/** The run's record: steps by area, each passed or failed, each with its screenshot. */
export function recorder(out) {
  mkdirSync(out, { recursive: true })
  const results = []
  let index = 0
  return {
    results,
    /** One check in an area: prints it, keeps it, and saves the page as it is now. */
    async step(page, area, what, ok, detail) {
      index++
      const file = out + '/' + String(index).padStart(2, '0') + '-' + area + '-' + slug(what) + '.png'
      await page.screenshot({ path: file }).catch(() => {})
      results.push({ area, what, ok: Boolean(ok), detail, file })
      const shown = detail === undefined ? '' : '  ' + (typeof detail === 'string' ? detail : JSON.stringify(detail)).slice(0, 400)
      console.log((ok ? 'pass ' : 'FAIL ') + area.padEnd(9) + ' ' + what + shown)
      return Boolean(ok)
    },
  }
}

/** Resolves to true when test() holds, polled until the timeout; false at the timeout. */
export async function until(test, ms = 10_000, every = 150) {
  const end = Date.now() + ms
  for (;;) {
    try {
      if (await test()) return true
    } catch {}
    if (Date.now() > end) return false
    await new Promise((resolve) => setTimeout(resolve, every))
  }
}

/** Waits until the page has hydrated and its feed runs: the top bar's live cursor shows a number. */
export const hydrated = (page, ms = 45_000) => until(async () => /#\d+/.test(await page.getByTestId('live-cursor').innerText()), ms)

/** Stops an area at the first check it can't go past. */
export class Stop extends Error {}

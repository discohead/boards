// The board over HTTP: where it is, who is asking, and each request's answer or its failure.
import { Failure, misuse } from './failure.mjs'

const PROFILE = /^[A-Za-z][A-Za-z0-9-]{0,31}$/

/** The board, token, and profile from flags first, then BOARDS_URL, BOARDS_TOKEN, BOARDS_PROFILE. */
export function connect(flags, env, { token: needsToken = true } = {}) {
  const rawUrl = flags.url ?? env.BOARDS_URL
  if (!rawUrl)
    throw misuse('no_board', 'no board to use: BOARDS_URL is not set', ["Set BOARDS_URL to the board's URL, like https://boards.example.com/b/team.", 'Or pass --url <url>.'])
  let parsed
  try {
    parsed = new URL(rawUrl)
  } catch {
    throw misuse('invalid_url', 'the board URL is not a URL: ' + rawUrl, ['Set BOARDS_URL to a URL like https://boards.example.com/b/team.'])
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') throw misuse('invalid_url', 'the board URL is not http or https: ' + rawUrl)
  const url = (parsed.origin + parsed.pathname).replace(/\/+$/, '')
  const token = flags.token ?? env.BOARDS_TOKEN
  if (needsToken && !token) throw misuse('no_token', 'no token for ' + url + ': BOARDS_TOKEN is not set', [['boards', 'token'], 'Or pass --token <token>.'])
  const profile = flags.as ?? env.BOARDS_PROFILE ?? null
  if (profile !== null && profile !== '' && !PROFILE.test(profile))
    throw misuse('invalid_profile', 'a profile starts with a letter and has up to 32 letters, numbers, and hyphens, not ' + profile)
  return new Board(url, token ?? null, profile || null)
}

export class Board {
  constructor(url, token, profile) {
    this.url = url
    this.token = token
    this.profile = profile
  }

  headers(extra = {}) {
    return {
      ...(this.token ? { authorization: 'Bearer ' + this.token } : {}),
      ...(this.profile ? { 'x-board-profile': this.profile } : {}),
      'user-agent': 'boards-cli',
      ...extra,
    }
  }

  href(path, query) {
    const search = new URLSearchParams()
    for (const [key, value] of Object.entries(query ?? {})) {
      if (value === undefined || value === null) continue
      for (const one of Array.isArray(value) ? value : [value]) search.append(key, String(one))
    }
    const qs = search.toString()
    return this.url + path + (qs ? '?' + qs : '')
  }

  /**
   * One request. doing says what the command was doing, for the headline of a failure.
   * @returns the JSON answer, or the Response itself with raw: true.
   */
  async request(doing, method, path, { query, body, bytes, headers = {}, raw = false, signal } = {}) {
    const init = { method, headers: this.headers(headers), signal }
    if (bytes !== undefined) init.body = bytes
    else if (body !== undefined) {
      init.body = JSON.stringify(body)
      init.headers['content-type'] = 'application/json'
    }
    let response
    try {
      response = await fetch(this.href(path, query), init)
    } catch (error) {
      if (error?.name === 'AbortError') throw error
      throw unreachable(doing, this.url, error)
    }
    if (!response.ok) throw await boardFailure(doing, method, path, response)
    if (raw) return response
    const text = await response.text()
    try {
      return text ? JSON.parse(text) : {}
    } catch {
      throw new Failure({ reason: 'bad_answer', headline: doing + ': the board answered something that is not JSON', origin: 'board' })
    }
  }
}

export function unreachable(doing, url, error) {
  const why = error?.cause?.code ?? error?.cause?.message ?? error?.message ?? 'no answer'
  return new Failure({ reason: 'unreachable', headline: doing + ': no answer from ' + url + ' (' + why + ')', ways: ['Check BOARDS_URL, and that the board is up.'] })
}

/** What a board answered, said by what the command was doing; the board's words go under it. */
export async function boardFailure(doing, method, path, response) {
  let body = null
  try {
    body = JSON.parse(await response.text())
  } catch {}
  const error = body && typeof body.error === 'object' && body.error ? body.error : null
  const code = typeof error?.code === 'string' ? error.code : 'http_error'
  const message = typeof error?.message === 'string' ? error.message : 'HTTP ' + response.status
  const board = { status: response.status, code, message, ...(typeof error?.hint === 'string' ? { hint: error.hint } : {}) }
  let reason = code
  let headline = doing
  let ways = []
  if (response.status === 401) {
    headline = doing + ': the board did not take the token'
    ways = [['boards', 'token'], "Check that the token was made for this board's URL."]
  } else if (response.status === 403) headline = doing + ': the token may not do that'
  else if (response.status === 404 && code === 'not_found' && /^no route/.test(message)) {
    reason = 'not_supported'
    headline = doing + ': this board does not serve ' + method + ' ' + path.replace(/\/[^/]*%[^/]*|\/\d+(?=\/|$)/g, '/:id')
  } else if (response.status === 501) {
    reason = 'not_supported'
    headline = doing + ': this board keeps none of that'
  } else if (response.status === 429 || response.status >= 500) headline = doing + ': the board failed to answer (' + response.status + ')'
  const retryAfter = response.headers.get('retry-after')
  return new Failure({ reason, headline, ways, origin: 'board', board, data: { status: response.status, ...(retryAfter ? { retryAfter } : {}) } })
}

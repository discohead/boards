// The bus over HTTP, from the browser: /b/<name> on the same origin, with the Access cookie, or a
// bearer token (wrangler dev, or a script). A refusal is a BusRefusal carrying the board's error.

export class BusRefusal extends Error {
  status: number
  code: string
  constructor(status: number, code: string, message: string) {
    super(code + ': ' + message)
    this.name = 'BusRefusal'
    this.status = status
    this.code = code
  }
}

export type BusOptions = { url: string; token?: string; fetch?: typeof fetch }

export class BusClient {
  url: string
  token: string | undefined
  #fetch: typeof fetch
  constructor(options: BusOptions) {
    this.url = options.url.replace(/\/+$/, '')
    this.token = options.token
    this.#fetch = options.fetch ?? ((input, init) => fetch(input, init))
  }

  headers(extra: Record<string, string> = {}): Record<string, string> {
    return { ...(this.token ? { authorization: 'Bearer ' + this.token } : {}), ...extra }
  }

  raw(path: string, init: RequestInit = {}): Promise<Response> {
    return this.#fetch(this.url + path, { credentials: 'same-origin', ...init, headers: this.headers(init.headers as Record<string, string>) })
  }

  async call<T>(method: string, path: string, body?: unknown, signal?: AbortSignal): Promise<T> {
    const response = await this.raw(path, { method, ...(body !== undefined ? { body: JSON.stringify(body), headers: { 'content-type': 'application/json' } } : {}), ...(signal ? { signal } : {}) })
    const text = await response.text()
    let value: unknown = null
    try {
      value = text ? JSON.parse(text) : null
    } catch {
      throw new BusRefusal(response.status, 'bad_answer', 'the bus answered something that is not JSON (' + response.status + ')')
    }
    if (!response.ok) {
      const error = (value as { error?: { code?: string; message?: string } } | null)?.error
      throw new BusRefusal(response.status, error?.code ?? 'http_' + response.status, error?.message ?? response.statusText)
    }
    return value as T
  }

  get = <T>(path: string, signal?: AbortSignal) => this.call<T>('GET', path, undefined, signal)
  post = <T>(path: string, body?: unknown) => this.call<T>('POST', path, body ?? {})
}

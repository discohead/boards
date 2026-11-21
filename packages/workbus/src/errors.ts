// Errors are data: a status, a code to branch on, a message that says what and why, and at most a
// hint that says what fixes it. They cross RPC as plain objects, never as thrown classes.

export type Failure = { status: number; code: string; message: string; hint?: string; data?: Record<string, unknown> }

export class WorkbusError extends Error {
  readonly status: number
  readonly code: string
  readonly hint?: string
  readonly data?: Record<string, unknown>
  constructor(status: number, code: string, message: string, extra: { hint?: string; data?: Record<string, unknown> } = {}) {
    super(message)
    this.name = 'WorkbusError'
    this.status = status
    this.code = code
    if (extra.hint !== undefined) this.hint = extra.hint
    if (extra.data !== undefined) this.data = extra.data
  }
  toFailure(): Failure {
    return { status: this.status, code: this.code, message: this.message, ...(this.hint ? { hint: this.hint } : {}), ...(this.data ? { data: this.data } : {}) }
  }
}

export const badRequest = (message: string, code = 'invalid_request', hint?: string) => new WorkbusError(400, code, message, hint ? { hint } : {})
export const unauthorized = (message: string, code = 'unauthorized') => new WorkbusError(401, code, message)
export const forbidden = (message: string, code = 'forbidden', hint?: string) => new WorkbusError(403, code, message, hint ? { hint } : {})
export const notFound = (message: string, code = 'not_found') => new WorkbusError(404, code, message)
export const conflict = (code: string, message: string) => new WorkbusError(409, code, message)
export const notKept = (code: string, message: string) => new WorkbusError(501, code, message)

export function failureOf(error: unknown): Failure {
  if (error instanceof WorkbusError) return error.toFailure()
  if (error && typeof error === 'object' && 'status' in error && 'code' in error && 'message' in error) return error as Failure
  // The platform's word that the board's Durable Object has more work queued than it can take.
  if (error && typeof error === 'object' && ((error as { overloaded?: boolean }).overloaded === true || /Durable Object is overloaded/.test(String((error as Error).message))))
    return { status: 503, code: 'overloaded', message: 'the board has more writes queued than it can take right now: try again in a moment' }
  console.error('[workbus] unexpected error:', error)
  return { status: 500, code: 'internal', message: 'something went wrong on the board' }
}

export function failureResponse(failure: Failure, headers: HeadersInit = {}): Response {
  if (failure.code === 'overloaded' || failure.code === 'archive_unavailable') headers = { 'retry-after': '1', ...Object.fromEntries(new Headers(headers)) }
  return Response.json({ error: { code: failure.code, message: failure.message, ...(failure.hint ? { hint: failure.hint } : {}), ...(failure.data ? { data: failure.data } : {}) } }, { status: failure.status, headers })
}

import { describe, expect, it } from 'vitest'
import { failureOf, failureResponse } from '../src/errors.ts'

// What a caller sees when the platform says a board's Durable Object has too much work queued.
describe('an overloaded board', () => {
  it('answers 503 overloaded with Retry-After, not a 500', async () => {
    const thrown = Object.assign(new Error('Durable Object is overloaded. Requests queued for too long.'), { overloaded: true, retryable: false })
    const response = failureResponse(failureOf(thrown))
    expect(response.status).toBe(503)
    expect(response.headers.get('retry-after')).toBe('1')
    expect(((await response.json()) as { error: { code: string } }).error.code).toBe('overloaded')
  })
  it('still answers 500 for an error it does not know', async () => {
    const response = failureResponse(failureOf(new TypeError('x is undefined')))
    expect(response.status).toBe(500)
    expect(response.headers.get('retry-after')).toBeNull()
  })
})

// The route table: method, path, what it takes, what it answers with. The Gateway routes, checks,
// and authenticates by it; the Ledger runs the method of the same name.
import type { z } from 'zod'
import type { GatewayEnv, LedgerStub, Mount } from '../gateway/gateway.ts'
import type { Caller } from '../ledger/core.ts'

export type Route = {
  name: string
  method: 'GET' | 'POST' | 'PATCH'
  path: string
  query?: z.ZodType
  body?: z.ZodType
  /** The body may be absent (an empty body reads as undefined). */
  optionalBody?: boolean
  /** No caller: discovery, avatars, webhooks. */
  open?: boolean
  /** 201 for something new: always, or when the answer says created. */
  status?: 201 | 'created'
  /** Served by the Gateway itself, not the Ledger. */
  gateway?: boolean
}

export const ROUTES: Route[] = []

/** Gateway handlers for routes the Gateway serves itself (files' bytes, webhooks), by route name.
 * Here, not in gateway.ts, so a protocol module can register at load: gateway.ts imports them first. */
export const GATEWAY: Record<string, (request: Request, env: GatewayEnv, ctx: { mount: Mount; caller: Caller | null; params: Record<string, string>; input: unknown; ledger: LedgerStub }) => Promise<Response>> = {}
export const route = (definition: Route) => void ROUTES.push(definition)

type Compiled = Route & { pattern: RegExp; params: string[]; literals: number; segments: number }
let compiled: Compiled[] | null = null

function compileAll(): Compiled[] {
  compiled ??= ROUTES.map((definition) => {
    const params: string[] = []
    const parts = definition.path.split('/').filter(Boolean)
    const source = parts.map((part) => (part.startsWith(':') ? (params.push(part.slice(1)), '([^/]+)') : part.replace(/[.*+?^\${}()|[\]\\]/g, '\\$&'))).join('/')
    return { ...definition, pattern: new RegExp('^/' + source + '$'), params, literals: parts.filter((part) => !part.startsWith(':')).length, segments: parts.length }
  }).sort((a, b) => b.segments - a.segments || b.literals - a.literals)
  return compiled
}

/** The route a method and path (below the board's mount) name, with its decoded parameters. */
export function match(method: string, path: string): { route: Route; params: Record<string, string> } | null {
  const trimmed = path.length > 1 ? path.replace(/\/+$/, '') : path
  for (const candidate of compileAll()) {
    if (candidate.method !== method) continue
    const found = candidate.pattern.exec(trimmed === '' ? '/' : trimmed)
    if (!found) continue
    try {
      const params = Object.fromEntries(candidate.params.map((name, i) => [name, decodeURIComponent(found[i + 1]!)]))
      return { route: candidate, params }
    } catch {
      return null
    }
  }
  return null
}

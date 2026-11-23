// The app Worker's entry: Start's handler behind an Access check, and the app's Durable Objects and
// entrypoints as named exports (design/workbus.md §9.1).
import handler from '@tanstack/react-start/server-entry'
import { getAgentByName } from 'agents'

import { checkAccess } from './access.ts'
import { sessionName, type SessionStub } from './harness/pi.ts'

export { Session } from './seats/session.ts'
export { SeatWorkspace } from './seats/workspace.ts'

export default {
  async fetch(request, env) {
    const refused = await checkAccess(request, env)
    if (refused) return refused
    if (import.meta.env.DEV && new URL(request.url).pathname === '/dev/session') return devSession(request, env)
    return handler.fetch(request)
  },
} satisfies ExportedHandler<Env>

/**
 * vite dev only: drive one Session by hand, as a Seat would, to check it against a local bus.
 * POST { seat, thread, call: 'configure' | 'submit' | 'wait' | 'abort' | 'inspect' | 'watch' | 'workspace.<method>', args }.
 */
async function devSession(request: Request, env: Env): Promise<Response> {
  const { seat, thread, call, args = [] } = (await request.json()) as { seat: string; thread: string; call: string; args?: unknown[] }
  try {
    // 'workspace.<method>': the seat's SeatWorkspace itself, as its sessions call it.
    if (call.startsWith('workspace.')) {
      const space = env.WORKSPACE.getByName(seat) as unknown as Record<string, (...args: unknown[]) => Promise<unknown>>
      return Response.json((await space[call.slice('workspace.'.length)]!(...args)) ?? null)
    }
    const stub = (await getAgentByName(env.SESSION as any, sessionName(seat, thread))) as unknown as SessionStub & Record<string, (...args: unknown[]) => Promise<unknown>>
    if (call === 'watch') return new Response(await stub.watch(), { headers: { 'content-type': 'application/x-ndjson' } })
    return Response.json((await stub[call]!(...args)) ?? null)
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : String(error) }, { status: 500 })
  }
}

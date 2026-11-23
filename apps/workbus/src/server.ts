// The app Worker's entry: Start's handler behind an Access check, and the app's Durable Objects
// and entrypoints as named exports (design/workbus.md §9.1, §10.1): Seat and Session, the seats'
// runtime, and Wake, the bus's sink for their wakes and the reconciler's.
import handler from '@tanstack/react-start/server-entry'
import { getAgentByName } from 'agents'

import { checkAccess } from './access.ts'
import { bus } from './bus.ts'
import { sessionName, type SessionStub } from './harness/pi.ts'
import { boot } from './org/boot.ts'
import { reconcile } from './org/reconcile.ts'
import { seatOf } from './seats/wake.ts'

export { Seat } from './seats/seat.ts'
export { Session } from './seats/session.ts'
export { SeatWorkspace } from './seats/workspace.ts'
export { Wake } from './seats/wake.ts'

/** Once per isolate: the org seeded, the reconciler's wake set, and a first pass (org/boot.ts). */
let booting: Promise<unknown> | null = null
function bootOnce(env: Env) {
  booting ??= boot(bus(), seatOf(env)).then(
    (booted) => console.log('org: seeded ' + (booted.seeded.join(', ') || 'nothing') + '; reconciler ' + booted.reconciler + '; ' + booted.pass.applied.map((seat) => seat.seat + ' ' + seat.wake).join(', ')),
    (error) => {
      booting = null
      console.error('org: boot failed', error)
    },
  )
  return booting
}

export default {
  async fetch(request, env, ctx) {
    const refused = await checkAccess(request, env)
    if (refused) return refused
    // The dev doors don't boot, so a check sees what the reconciler's wake does on its own.
    if (import.meta.env.DEV && new URL(request.url).pathname === '/dev/session') return devSession(request, env)
    if (import.meta.env.DEV && new URL(request.url).pathname === '/dev/seat') return devSeat(request, env)
    ctx.waitUntil(bootOnce(env))
    const seat = /^\/api\/seats\/([a-z][a-z0-9-]{0,31})$/.exec(new URL(request.url).pathname)?.[1]
    if (seat && request.method === 'GET') return seatStatus(env, seat, new URL(request.url).searchParams.get('file'))
    return handler.fetch(request)
  },
} satisfies ExportedHandler<Env>

/**
 * GET /api/seats/<key>, behind Access: the Seat's status (its state, queue, holds, spend, and last
 * runs), for the app's views and the live checks. ?file=<path> reads a file in its workspace.
 */
async function seatStatus(env: Env, key: string, path: string | null): Promise<Response> {
  if (path !== null) {
    if (!/^\/workspace\/[^\0]{1,512}$/.test(path) || path.includes('..')) return Response.json({ error: 'file is a path under /workspace' }, { status: 400 })
    const space = env.WORKSPACE.getByName(key) as unknown as { execute(call: { id: string; name: string; arguments: unknown }): Promise<{ content: { type: string; text?: string }[]; isError?: boolean }> }
    const read = await space.execute({ id: 'status-read-' + crypto.randomUUID(), name: 'read', arguments: { path } })
    return Response.json({ path, text: read.content.map((part) => part.text ?? '').join(''), error: read.isError === true })
  }
  const status = (await (env.SEAT.getByName(key) as unknown as { status(): Promise<{ runtime: unknown }> }).status())
  if (!status.runtime) return Response.json({ error: 'no seat ' + key }, { status: 404 })
  return Response.json(status)
}

/** vite dev only: a Seat's methods, a boot, or a reconcile pass, for checks. POST { seat, call: 'status', args }, or { call: 'boot' | 'reconcile' }. */
async function devSeat(request: Request, env: Env): Promise<Response> {
  const { seat, call, args = [] } = (await request.json()) as { seat?: string; call: string; args?: unknown[] }
  try {
    if (call === 'reconcile') return Response.json(await reconcile(bus(), seatOf(env), args[0] as string | undefined))
    if (call === 'boot') return Response.json(await boot(bus(), seatOf(env)))
    const stub = env.SEAT.getByName(seat!) as unknown as Record<string, (...args: unknown[]) => Promise<unknown>>
    return Response.json((await stub[call]!(...args)) ?? null)
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : String(error) }, { status: 500 })
  }
}

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

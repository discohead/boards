// The Wake entrypoint: the bus's "wake" sink (design/registered-watchers.md). The bus's Mailbox
// calls wake(event, context) for each match, in order per thread, at least once. The reconciler's
// own wake (org/'s doc events) runs a reconcile; each seat's goes to its Seat, which dedupes on
// (wake, cursor). Nothing else is accepted: a delivery says which wake and actor it is, and they
// have to agree.
import { WorkerEntrypoint } from 'cloudflare:workers'

import { bus } from '../bus.ts'
import { reconcile, ORG_WAKE, SEAT_PREFIX, type SeatStub } from '../org/reconcile.ts'
import type { Delivered, DeliveredContext } from './seat.ts'

const APP = 'worker:workbus-app'

export const seatOf = (env: Env) => (key: string) => env.SEAT.getByName(key) as unknown as SeatStub

export class Wake extends WorkerEntrypoint<Env> {
  async wake(event: Delivered, context: DeliveredContext): Promise<unknown> {
    if (context.principal !== APP) throw new Error('wake: a delivery for ' + context.principal + ", which isn't this app")
    if (context.wake === ORG_WAKE) {
      if (context.actor !== APP) throw new Error("wake: the org's wake is the app's own, not " + context.actor + "'s")
      const doc = event.message ? (event.message.re ?? event.message.id) : (event.payload?.id ?? undefined)
      const pass = await reconcile(bus(), seatOf(this.env), doc === undefined ? undefined : String(doc))
      console.log('wake: org ' + event.type + ' at ' + event.cursor + ': ' + pass.applied.map((seat) => seat.seat + ' ' + seat.wake).join(', ') + (pass.replies.length ? '; replied in ' + pass.replies.join(', ') : ''))
      return { reconciled: pass.applied, problems: pass.plan.problems.length, replies: pass.replies }
    }
    if (context.wake.startsWith(SEAT_PREFIX)) {
      const key = context.wake.slice(SEAT_PREFIX.length)
      if (context.actor !== APP + '+' + key) throw new Error('wake: ' + context.wake + ' is delivered as ' + context.actor + ', not the seat ' + key)
      return this.env.SEAT.getByName(key).wake(event, context)
    }
    console.warn('wake: no one takes the wake ' + context.wake)
    return { ignored: true }
  }
}

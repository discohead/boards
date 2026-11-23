// Who a task may be assigned to (design/cross-principal-tasks.md): the principal, the owner's own
// profiles, and every seat (worker:workbus-app+<key>), whoever owns the task. The board takes any
// actor it knows, or a profile of a principal it knows, so a seat that hasn't written yet is offered too.
import { useMemo } from 'react'
import { useLiveQuery } from '@tanstack/react-db'
import { useBus } from '@/data'
import { seatInitials, useSeats } from '@/seats/use-seats'

export type Assignee = { id: string; name: string; handle: string; kind: 'person' | 'agent'; initials: string; seat: boolean }

import { initialsFor } from '@/seats/initials'

export function useAssignable(owner: string | null | undefined, me: string | null | undefined): Assignee[] {
  const bus = useBus()
  const { seats } = useSeats()
  const { data: actors } = useLiveQuery({ query: (q) => q.from({ actor: bus.actors }) })
  return useMemo(() => {
    const out = new Map<string, Assignee>()
    for (const seat of seats) out.set(seat.actor, { id: seat.actor, name: seat.name, handle: seat.handle, kind: 'agent', initials: seatInitials(seat), seat: true })
    for (const actor of actors) {
      if (out.has(actor.id)) continue
      const mine = me && actor.id === me
      const profile = owner && actor.id.startsWith(owner + '+')
      if (!mine && !profile) continue
      out.set(actor.id, { id: actor.id, name: actor.name, handle: actor.handle, kind: actor.kind === 'person' ? 'person' : 'agent', initials: initialsFor(actor.id, actor.name, actor.handle), seat: false })
    }
    // Seats first (who the work usually goes to), then the principal, then its profiles.
    return [...out.values()].sort((a, b) => Number(b.seat) - Number(a.seat) || Number(b.id === me) - Number(a.id === me) || a.name.localeCompare(b.name))
  }, [seats, actors, owner, me])
}

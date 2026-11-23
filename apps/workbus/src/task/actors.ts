// Names for actor IDs, from the actors collection: a profile (<actor>+<profile>) is its actor's
// handle and its profile, as the board writes it (@jared+op).
import { useMemo } from 'react'
import { useLiveQuery } from '@tanstack/react-db'
import { useBus } from '@/data'

export function useActorNames() {
  const bus = useBus()
  const { data: actors } = useLiveQuery({ query: (q) => q.from({ actor: bus.actors }) })
  return useMemo(() => {
    const handles = new Map(actors.map((actor) => [actor.id, actor.handle]))
    return (id: string | null | undefined) => {
      if (!id) return ''
      const known = handles.get(id)
      if (known) return known
      const plus = id.lastIndexOf('+')
      if (plus > 0) return (handles.get(id.slice(0, plus)) ?? tail(id.slice(0, plus))) + '+' + id.slice(plus + 1)
      return tail(id)
    }
  }, [actors])
}

/** workbus:user:jared → jared: the last part of an ID the actors collection doesn't know yet. */
const tail = (id: string) => id.slice(id.lastIndexOf(':') + 1)

/** Whether an ID is a person (round) or an agent (square), for the system's Avatar: a Worker, or a profile of one, is an agent. */
export function useActorKinds() {
  const bus = useBus()
  const { data: actors } = useLiveQuery({ query: (q) => q.from({ actor: bus.actors }) })
  return useMemo(() => {
    const kinds = new Map(actors.map((actor) => [actor.id, actor.kind]))
    // A profile (<actor>+<profile>) is a seat, an agent; so is a Worker. A person is round.
    return (id: string): 'person' | 'agent' => (!id.includes('+') && kinds.get(id) === 'person' ? 'person' : id.includes('+') || id.startsWith('worker:') ? 'agent' : 'person')
  }, [actors])
}

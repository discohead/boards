// Actors' display names, live from the actors collection: a person's own name (PATCH /me) shows
// everywhere at once, old messages included, rather than the name a message carried when it came.
import { useMemo } from 'react'
import { useLiveQuery } from '@tanstack/react-db'
import { useBus } from '@/data'

export function useDisplayNames() {
  const bus = useBus()
  const { data: actors } = useLiveQuery({ query: (q) => q.from({ actor: bus.actors }) })
  return useMemo(() => {
    const names = new Map(actors.map((actor) => [actor.id, actor.name]))
    return (id: string, fallback: string) => names.get(id) || fallback
  }, [actors])
}

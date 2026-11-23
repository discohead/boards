// The page's data: one DbClient in the browser (its collections follow the bus's live feed), a fresh
// one per render on the server. Either starts from the first pages the root loader read.
import { useEffect, useState, type ReactNode } from 'react'
import type { DehydratedDbState } from '@tanstack/db'
import { DbProvider, HydrationBoundary } from '@tanstack/react-db'
import { useRouter } from '@tanstack/react-router'
import { browserDb, renderDb, runtimeOf, type Me } from './data/index.ts'
import { BOARD } from './board.ts'

export function BusProvider({ state, me, token, children }: { state: DehydratedDbState | null; me: Me | null; token: string | null; children: ReactNode }) {
  const [db] = useState(() => (typeof window === 'undefined' ? renderDb(me) : browserDb({ url: '/b/' + BOARD, me, ...(token ? { token } : {}) })))
  // After the first client render has matched the server's, the collections take the feed and their
  // reads. This effect runs once this tree has hydrated, but a route's lazily loaded component can
  // still be hydrating below it, so the gate opens once the matched routes' chunks are in and React
  // has had a frame to hydrate them.
  const router = useRouter()
  useEffect(() => {
    let live = true
    const chunks = router.state.matches.map((match) => router.loadRouteChunk((router.routesById as unknown as Record<string, Parameters<typeof router.loadRouteChunk>[0]>)[match.routeId]!))
    void Promise.all(chunks)
      .then(() => new Promise((resolve) => requestAnimationFrame(() => setTimeout(resolve, 0))))
      .then(() => live && runtimeOf(db).markHydrated())
    return () => {
      live = false
    }
  }, [db, router])
  return (
    <DbProvider client={db}>
      <HydrationBoundary state={state ?? { collections: [] }}>{children}</HydrationBoundary>
    </DbProvider>
  )
}

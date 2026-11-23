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
  // still be hydrating below it: the gate opens once the matched routes' chunks are in and React's
  // scheduled hydration work is done (the browser is idle). threads' hyd-repro.mjs, without its own
  // guards: this effect alone, 6 of 6 loads mismatched; chunks and a frame, 5 of 6; this, 0 of 12.
  const router = useRouter()
  useEffect(() => {
    let live = true
    const chunks = router.state.matches.map((match) => router.loadRouteChunk((router.routesById as unknown as Record<string, Parameters<typeof router.loadRouteChunk>[0]>)[match.routeId]!))
    void Promise.all(chunks)
      // React hydrates a boundary whose code just arrived as scheduled work; idle means that work is done.
      .then(() => new Promise((resolve) => requestAnimationFrame(() => (typeof requestIdleCallback === 'function' ? requestIdleCallback(() => resolve(undefined), { timeout: 1000 }) : setTimeout(resolve, 50)))))
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

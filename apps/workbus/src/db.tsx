// The page's data: one DbClient in the browser (its collections follow the bus's live feed), a fresh
// one per render on the server. Either starts from the first pages the root loader read.
import { useEffect, useState, type ReactNode } from 'react'
import type { DehydratedDbState } from '@tanstack/db'
import { DbProvider, HydrationBoundary } from '@tanstack/react-db'
import { browserDb, renderDb, runtimeOf, type Me } from './data/index.ts'
import { BOARD } from './board.ts'

export function BusProvider({ state, me, token, children }: { state: DehydratedDbState | null; me: Me | null; token: string | null; children: ReactNode }) {
  const [db] = useState(() => (typeof window === 'undefined' ? renderDb(me) : browserDb({ url: '/b/' + BOARD, me, ...(token ? { token } : {}) })))
  // After the first client render has matched the server's, the collections take the feed and their reads.
  useEffect(() => runtimeOf(db).markHydrated(), [db])
  return (
    <DbProvider client={db}>
      <HydrationBoundary state={state ?? { collections: [] }}>{children}</HydrationBoundary>
    </DbProvider>
  )
}

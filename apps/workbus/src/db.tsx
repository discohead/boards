// The page's data: one DbClient in the browser (its collections follow the bus's live feed), a fresh
// one per render on the server. Either starts from the first pages the root loader read.
import { useState, type ReactNode } from 'react'
import type { DehydratedDbState } from '@tanstack/db'
import { DbProvider, HydrationBoundary } from '@tanstack/react-db'
import { browserDb, renderDb } from './data/index.ts'
import { BOARD } from './board.ts'

export function BusProvider({ state, token, children }: { state: DehydratedDbState | null; token: string | null; children: ReactNode }) {
  const [db] = useState(() => (typeof window === 'undefined' ? renderDb() : browserDb({ url: '/b/' + BOARD, ...(token ? { token } : {}) })))
  return (
    <DbProvider client={db}>
      <HydrationBoundary state={state ?? { collections: [] }}>{children}</HydrationBoundary>
    </DbProvider>
  )
}

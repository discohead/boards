// The org as the browser sees it: orgView (views.ts), read when a view opens and every 10 s while
// one shows it and the tab is visible. Seats' live states come from useSeats.
import { useSyncExternalStore } from 'react'
import { orgView, type OrgView } from './views.ts'

const POLL_MS = 10_000
type Snapshot = { org: OrgView | null; error: string | null }
let snapshot: Snapshot = { org: null, error: null }
const listeners = new Set<() => void>()
let timer: ReturnType<typeof setTimeout> | null = null

async function poll() {
  timer = null
  if (listeners.size === 0) return
  if (document.visibilityState === 'visible') {
    try {
      snapshot = { org: await orgView(), error: null }
    } catch (error) {
      snapshot = { ...snapshot, error: error instanceof Error ? error.message : String(error) }
    }
    listeners.forEach((listener) => listener())
  }
  if (listeners.size) timer = setTimeout(poll, POLL_MS)
}

function subscribe(listener: () => void) {
  listeners.add(listener)
  if (listeners.size === 1) void poll()
  return () => {
    listeners.delete(listener)
    if (listeners.size === 0 && timer) clearTimeout(timer), (timer = null)
  }
}

const empty: Snapshot = { org: null, error: null }
export const useOrg = () => useSyncExternalStore(subscribe, () => snapshot, () => empty)

/** Reads the org again now: after a write to one of its docs. */
export function refreshOrg() {
  if (timer) clearTimeout(timer)
  void poll()
}

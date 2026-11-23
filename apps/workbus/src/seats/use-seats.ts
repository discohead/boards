// The seats as the browser sees them: one poll of seatViews (views.ts) shared by every view that
// shows them (the sidebar, a seat's page, Assign), every few seconds while anything shows them and
// the tab is visible, and at once when it comes back into view.
import { useSyncExternalStore } from 'react'
import { seatViews, type SeatView } from './views.ts'

export const POLL_MS = 4_000

type Snapshot = { seats: SeatView[]; ready: boolean; error: string | null; at: string | null }
let snapshot: Snapshot = { seats: [], ready: false, error: null, at: null }
const listeners = new Set<() => void>()
let timer: ReturnType<typeof setTimeout> | null = null
let inFlight = false

const emit = () => listeners.forEach((listener) => listener())

async function poll() {
  timer = null
  if (inFlight || listeners.size === 0) return
  if (document.visibilityState === 'visible') {
    inFlight = true
    try {
      const answer = await seatViews()
      snapshot = { seats: answer.seats, ready: true, error: null, at: answer.at }
    } catch (error) {
      snapshot = { ...snapshot, ready: true, error: error instanceof Error ? error.message : String(error) }
    } finally {
      inFlight = false
    }
    emit()
  }
  if (listeners.size) timer = setTimeout(poll, POLL_MS)
}

const visible = () => {
  if (document.visibilityState !== 'visible') return
  if (timer) clearTimeout(timer)
  void poll()
}

function subscribe(listener: () => void) {
  listeners.add(listener)
  if (listeners.size === 1) {
    document.addEventListener('visibilitychange', visible)
    void poll()
  }
  return () => {
    listeners.delete(listener)
    if (listeners.size === 0) {
      document.removeEventListener('visibilitychange', visible)
      if (timer) clearTimeout(timer)
      timer = null
    }
  }
}

const empty: Snapshot = { seats: [], ready: false, error: null, at: null }

/** Every seat, live. */
export function useSeats(): Snapshot {
  return useSyncExternalStore(subscribe, () => snapshot, () => empty)
}

/** Asks for a fresh read now: after a write that changes a seat (an answer to its hold). */
export function refreshSeats() {
  if (timer) clearTimeout(timer)
  void poll()
}

/**
 * Initials for a seat's square avatar, from its handle, as the prototype draws them (OP, AD, AV): its
 * first two letters, or, where another seat's handle sorts before it with the same two, its first
 * letter and the next letter of its handle that makes them unlike (Ada AD, Advisor AV).
 */
export function initialsAmong(handle: string, handles: readonly string[]): string {
  const taken = new Set<string>()
  for (const other of [...new Set([...handles, handle])].sort()) {
    const letters = other.replace(/[^a-z0-9]/gi, '').toUpperCase()
    let pick = letters.slice(0, 2)
    for (let i = 1; taken.has(pick) && i < letters.length; i++) pick = letters[0]! + letters[i]!
    taken.add(pick)
    if (other === handle) return pick || '?'
  }
  return handle.slice(0, 2).toUpperCase()
}

export const seatInitials = (seat: Pick<SeatView, 'name' | 'handle'>) => initialsAmong(seat.handle, snapshot.seats.map((one) => one.handle))

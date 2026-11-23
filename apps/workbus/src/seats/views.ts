// What the app's views show of the seats (design/workbus.md §5, §8.7): each seat in org/seats, with
// its live state, what it's working on, its spend this period, and its last runs, read from its
// Seat object. A server function, so the browser polls it; the Seat objects stay the app's. Every
// request reaching it has passed the app's Access check (server.ts), and the org is visible to
// everyone in it.
import { createServerFn } from '@tanstack/react-start'
import { env } from 'cloudflare:workers'

import { bus } from '../bus.ts'
import { readOrg } from '../org/reconcile.ts'
import type { SeatRuntime } from '../org/rules.ts'
import { prose } from '../org/rules.ts'
import type { Run } from '../telemetry/index.ts'
import type { Spend } from '../telemetry/totals.ts'
import type { SeatState } from './seat.ts'

/** The app's principal: a seat's actor is its profile, worker:workbus-app+<key>. */
export const APP_PRINCIPAL = 'worker:workbus-app'
export const seatActor = (key: string) => APP_PRINCIPAL + '+' + key

export type SeatRun = Pick<Run, 'id' | 'operation' | 'outcome' | 'cost' | 'started' | 'ended' | 'thread' | 'task' | 'steps' | 'error'>
export type SeatView = {
  key: string
  actor: string
  name: string
  handle: string
  role: string | null
  team: string | null
  state: SeatState
  /** The seat doc: its thread, and its prose (the charter, without its block). */
  doc: string | null
  charter: string
  /** What it's on now: the threads its sessions run or are parked in, and the tasks they hold for the principal. */
  open: { thread: string; state: 'running' | 'held' | 'queued' }[]
  holds: { task: string; thread: string }[]
  spend: { period: string; runs: number; cost: number; budget: number | null }
  runs: SeatRun[]
  /** The config revision its Seat holds (the newest of its seat, team, and root docs it was applied from). */
  revision: number | null
}

type Status = {
  revision?: number | null
  state: SeatState
  runtime: SeatRuntime | null
  wakes: { id: string; thread: string; state: string }[]
  holds: { task: string; thread: string; state: string }[]
  spend: (Spend & { budget: number | null }) | null
  runs: Run[]
}

/** The seat keys, from org/seats' docs: read at most every few seconds per isolate, so a poll doesn't read the org each time. */
let keys: { at: number; docs: Map<string, { id: string; text: string; title: string }> } | null = null
const KEYS_MS = 10_000

async function seatDocs() {
  if (keys && Date.now() - keys.at < KEYS_MS) return keys.docs
  const docs = (await readOrg(bus())).filter((doc) => doc.channel === 'org/seats')
  keys = { at: Date.now(), docs: new Map(docs.map((doc) => [doc.slug, { id: doc.id, text: doc.text, title: doc.title }])) }
  return keys.docs
}

/** One seat's view, from its doc and its Seat's status. */
export function viewOf(key: string, doc: { id: string; text: string; title: string } | null, status: Status): SeatView {
  const runtime = status.runtime
  const open = new Map<string, SeatView['open'][number]['state']>()
  for (const wake of status.wakes) {
    if (wake.state !== 'running' && wake.state !== 'held' && wake.state !== 'queued') continue
    const had = open.get(wake.thread)
    // running wins over held, held over queued: what the thread is doing now.
    if (!had || (had === 'queued' && wake.state !== 'queued') || (had === 'held' && wake.state === 'running')) open.set(wake.thread, wake.state)
  }
  return {
    key,
    actor: seatActor(key),
    name: runtime?.name ?? doc?.title ?? key,
    handle: runtime?.handle ?? key,
    role: runtime?.role ?? null,
    team: runtime?.team ?? null,
    state: status.state,
    doc: doc?.id ?? runtime?.doc ?? null,
    charter: doc ? prose(doc.text) : (runtime?.charter ?? ''),
    open: [...open].map(([thread, state]) => ({ thread, state })),
    holds: status.holds.filter((hold) => hold.state === 'held').map((hold) => ({ task: hold.task, thread: hold.thread })),
    spend: { period: status.spend?.period ?? new Date().toISOString().slice(0, 7), runs: status.spend?.runs ?? 0, cost: status.spend?.cost ?? 0, budget: status.spend?.budget ?? runtime?.budget.month ?? null },
    runs: status.runs.map((run) => ({ id: run.id, operation: run.operation, outcome: run.outcome, cost: run.cost, started: run.started, ended: run.ended, thread: run.thread, task: run.task, steps: run.steps, error: run.error })),
    revision: status.revision ?? null,
  }
}

export const seatViews = createServerFn().handler(async (): Promise<{ seats: SeatView[]; at: string }> => {
  const docs = await seatDocs()
  const seats = await Promise.all(
    [...docs].map(async ([key, doc]) => {
      const status = (await (env.SEAT.getByName(key) as unknown as { status(): Promise<Status> }).status()) as Status
      return viewOf(key, doc, status)
    }),
  )
  // The operator first, then by name: the sidebar's order.
  seats.sort((a, b) => (a.role === 'operator' ? -1 : b.role === 'operator' ? 1 : a.name.localeCompare(b.name)))
  return { seats, at: new Date().toISOString() }
})

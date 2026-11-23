// A request's record, read from the board and the seats: the message that started it, the threads
// that carry its label (GET /threads?label=org.request=<id>), the events that carry it in time order
// (GET /events, all of them, after the request), and the runs the seats made in those threads, with
// their cost (requestRuns). Read again every few seconds while shown, so it follows the work.
import { useEffect, useState } from 'react'
import { useBus, type Message } from '@/data'
import { requestRuns, type SeatRun } from '@/seats/views'
import { REQUEST_LABEL, type BoardEvent } from './model.ts'

export type RequestRecord = { root: Message | null; threads: Message[]; events: BoardEvent[]; runs: (SeatRun & { seat: string })[]; at: number }
const POLL_MS = 5_000
const label = (id: string) => encodeURIComponent(REQUEST_LABEL + '=' + id)

export function useRequest(id: string | null): { record: RequestRecord | null; error: string | null } {
  const bus = useBus()
  const [record, setRecord] = useState<RequestRecord | null>(null)
  const [error, setError] = useState<string | null>(null)
  useEffect(() => {
    if (!id) return
    let live = true
    let timer: ReturnType<typeof setTimeout> | null = null
    let lastEmpty = false
    const client = bus.runtime.client
    const read = async () => {
      try {
        const [root, threads] = await Promise.all([
          client.get<{ message: Message }>('/messages/' + id + '?limit=1').then((answer) => answer.message, () => null),
          client.get<{ threads: { message: Message }[] }>('/threads?label=' + label(id) + '&limit=200').then((answer) => answer.threads.map((one) => one.message)),
        ])
        const events: BoardEvent[] = []
        let after = String(Math.max(0, Number(id) - 1))
        for (let page = 0; page < 20; page++) {
          const answer = await client.get<{ events: BoardEvent[]; cursor: string }>('/events?label=' + label(id) + '&all=true&after=' + after)
          events.push(...answer.events)
          if (!answer.events.length || answer.cursor === after) break
          after = answer.cursor
        }
        const ids = [...new Set([id, ...(root?.re ? [root.re] : []), ...threads.map((one) => one.id)])]
        const { runs } = await requestRuns({ data: { threads: ids } })
        lastEmpty = threads.length === 0 && events.length === 0
        if (live) setRecord({ root, threads, events, runs, at: Date.now() }), setError(null)
      } catch (failed) {
        if (live) setError(failed instanceof Error ? failed.message : String(failed))
      }
      // Nothing yet carries it: look again less often (a request just posted gets its work in a moment).
      if (live) timer = setTimeout(read, lastEmpty ? POLL_MS * 3 : POLL_MS)
    }
    void read()
    return () => {
      live = false
      if (timer) clearTimeout(timer)
    }
  }, [bus, id])
  return { record, error }
}

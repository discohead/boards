// The threads in a channel that started a request (seats' work carries their ID as org.request), as
// a map from a thread's root to its request: what a DM shows "What happened with this" on. Read when
// the channel opens and every 15 s.
import { useEffect, useState } from 'react'
import { useBus, type Message } from '@/data'
import { REQUEST_LABEL } from './model.ts'

export function useRequestRoots(channel: string): Map<string, string> {
  const bus = useBus()
  const [roots, setRoots] = useState(new Map<string, string>())
  useEffect(() => {
    let live = true
    let timer: ReturnType<typeof setTimeout> | null = null
    const read = async () => {
      try {
        const answer = await bus.runtime.client.get<{ threads: { message: Message }[] }>('/threads?channel=' + encodeURIComponent(channel) + '&label=' + encodeURIComponent(REQUEST_LABEL) + '&limit=200')
        const next = new Map<string, string>()
        for (const { message } of answer.threads) {
          const labeled = message.labels?.[REQUEST_LABEL]
          // A person's root that seats' replies name is itself the request; a seat's root names the one it's for.
          const person = !(message.by.actor.includes('+') || message.by.actor.startsWith('worker:'))
          next.set(message.id, labeled ?? (person ? message.id : ''))
        }
        for (const [root, request] of next) if (!request) next.delete(root)
        if (live) setRoots(next)
      } catch {}
      if (live) timer = setTimeout(read, 15_000)
    }
    void read()
    return () => {
      live = false
      if (timer) clearTimeout(timer)
    }
  }, [bus, channel])
  return roots
}

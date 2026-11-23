// The inbox's items, live (items.ts), and the rule that a reply answers an item: my newest message
// in a thread with something unread, after what's unread, marks the thread read up to it. Mounted
// by the inbox, and by the frame for the sidebar's count.
import { useEffect, useMemo } from 'react'
import { useLiveQuery } from '@tanstack/react-db'
import { useBus, type Message } from '@/data'
import { useMe } from '@/task/me'
import { useTasks } from '@/task/use-tasks'
import { inboxItems } from './items.ts'
import { useReach } from './reach.ts'

export function useInbox() {
  const bus = useBus()
  const me = useMe()
  const reach = useReach()
  const tasks = useTasks()
  const { data: all } = useLiveQuery({ query: (q) => q.from({ message: bus.messages }) })
  const messages = useMemo(() => new Map(all.map((message) => [message.id, message as Message])), [all])
  const items = useMemo(() => (me && reach.ready ? inboxItems({ reach, tasks, messages, me: me.actor, can: me.can }) : []), [me, reach.ready, reach.threads, reach.channels, reach.reached, tasks, messages])

  useEffect(() => {
    if (!me) return
    for (const row of reach.threads.values()) {
      if (row.unread <= 0) continue
      let mine: Message | null = null
      for (const message of messages.values()) if (message.re === row.thread && message.by.actor === me.actor && !message.pending && (!mine || Number(message.id) > Number(mine.id))) mine = message
      const theirs = reach.reached.filter((message) => message.re === row.thread && message.by.actor !== me.actor).at(-1)
      if (mine && (!theirs || Number(mine.id) > Number(theirs.id))) void reach.markRead({ thread: row.thread }, mine.id)
    }
  }, [me, reach.threads, reach.reached, messages])

  return { items, ready: reach.ready, markRead: reach.markRead }
}

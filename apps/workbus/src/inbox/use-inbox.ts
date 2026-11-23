// The inbox's items, live (items.ts): the read state (bus.unread), held tasks and proposals (the
// tasks collection), and the messages in memory for each item's newest reply. It reads nothing
// itself, so the frame mounts it for the sidebar's count at no cost; the inbox view reads what
// reached the principal (openInbox) for the rest.
//
// A reply answers an item: my newest message in a thread with something unread, after the newest of
// theirs, marks the thread read up to it.
import { useEffect, useMemo, useState } from 'react'
import { useLiveQuery } from '@tanstack/react-db'
import { useBus, type Message } from '@/data'
import type { Unread } from '@/data/unread'
import { useMe } from '@/task/me'
import { useTasks } from '@/task/use-tasks'
import { inboxItems, newestTheirs } from './items.ts'

export function useInbox() {
  const bus = useBus()
  const me = useMe()
  const tasks = useTasks()
  const { data: unread, isReady } = useLiveQuery({ query: (q) => q.from({ row: bus.unread }) })
  const { data: all } = useLiveQuery({ query: (q) => q.from({ message: bus.messages }) })
  const messages = useMemo(() => new Map(all.map((message) => [message.id, message as Message])), [all])
  const rows = unread as Unread[]
  const items = useMemo(() => (me && isReady ? inboxItems({ unread: rows, tasks, messages, me: me.actor, can: me.can }) : []), [me, isReady, rows, tasks, messages])
  // The server's render has no read state to count, so neither does the first in the browser: the
  // items come in once the page has mounted (as the sidebar's count does).
  const [mounted, setMounted] = useState(false)
  useEffect(() => setMounted(true), [])
  const markRead = (target: { thread: string } | { channel: string }, upto?: string) => bus.actions.markRead({ ...target, ...(upto ? { upto } : {}) })

  useEffect(() => {
    if (!me) return
    const theirs = newestTheirs(messages.values(), me.actor)
    for (const row of rows) {
      if (row.kind !== 'thread' || !row.thread || row.unread <= 0) continue
      let mine: Message | null = null
      for (const message of messages.values()) if (message.re === row.thread && message.by.actor === me.actor && !message.pending && (!mine || Number(message.id) > Number(mine.id))) mine = message
      const last = theirs.get(row.thread)
      if (mine && last && Number(mine.id) > Number(last.id)) void markRead({ thread: row.thread }, mine.id)
    }
  }, [me, rows, messages])

  return { items: mounted ? items : [], ready: mounted && isReady, markRead }
}

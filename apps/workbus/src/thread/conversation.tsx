// The thread pane's conversation (design/workbus.md §4.1): the root and its replies, live, a box to
// reply in, and follow or unfollow. Opening it marks the thread read, and so does each reply that
// comes while it's open and the tab is visible. A new reply moves the list only when you're at its
// bottom.
import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { useLiveQuery } from '@tanstack/react-db'
import { useLocation } from '@tanstack/react-router'
import { eq, or } from '@tanstack/db'
import { useBus } from '@/data'
import { threadKey } from '@/data/unread'
import { Composer } from '@/channel/composer'
import { MessageItem } from '@/channel/message'

export function Conversation({ id }: { id: string }) {
  const bus = useBus()
  const { data: messages } = useLiveQuery({ query: (q) => q.from({ message: bus.messages }).where(({ message }) => or(eq(message.id, id), eq(message.re, id))) })
  const sorted = [...messages].sort((a, b) => (a.re === null ? -1 : b.re === null ? 1 : (a.pending ? Infinity : Number(a.id)) - (b.pending ? Infinity : Number(b.id))))
  const root = sorted.find((message) => message.re === null)
  const replies = sorted.filter((message) => message.re !== null && !(message.deleted && !message.text))
  const { data: follows } = useLiveQuery({ query: (q) => q.from({ follow: bus.follows }).where(({ follow }) => eq(follow.thread, id)) })
  const following = follows.length > 0
  const { data: counts } = useLiveQuery({ query: (q) => q.from({ row: bus.unread }).where(({ row }) => eq(row.key, threadKey(id))) })
  const unread = (counts[0]?.unread ?? 0) + (counts[0]?.mentions ?? 0)
  // Opened from the inbox, a thread stays unread: an inbox item leaves when it's answered or marked done (work's rule).
  const fromInbox = useLocation({ select: (location) => location.pathname === '/' })
  useEffect(() => {
    if (bus.unread.status !== 'ready' || fromInbox) return
    const mark = () => {
      if (document.visibilityState === 'visible') void bus.actions.markRead({ thread: id })
    }
    if (unread > 0 || counts.length === 0) mark()
    document.addEventListener('visibilitychange', mark)
    return () => document.removeEventListener('visibilitychange', mark)
  }, [bus, id, unread, bus.unread.status, fromInbox])

  const list = useRef<HTMLOListElement>(null)
  const atBottom = useRef(true)
  const lastKey = replies.at(-1)?.pending ?? replies.at(-1)?.id
  useLayoutEffect(() => {
    const scroller = list.current?.closest('[data-pane-scroll]')
    if (!scroller) return
    if (atBottom.current || replies.at(-1)?.pending) scroller.scrollTop = scroller.scrollHeight
  }, [lastKey])
  useEffect(() => {
    const scroller = list.current?.closest('[data-pane-scroll]')
    if (!scroller) return
    const onScroll = () => (atBottom.current = scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight < 60)
    scroller.addEventListener('scroll', onScroll)
    return () => scroller.removeEventListener('scroll', onScroll)
  }, [])

  const [editing, setEditing] = useState<string | null>(null)
  const editLast = () => {
    const mine = [...replies].reverse().find((message) => message.by.actor === bus.runtime.me.actor && !message.deleted && !message.pending)
    if (mine) setEditing(mine.id)
  }
  return (
    <section aria-label="Conversation" className="flex min-h-0 flex-1 flex-col">
      <div className="flex shrink-0 items-center gap-2 px-4 pt-3 pb-1">
        <h2 className="text-xs font-medium text-muted-foreground">
          {replies.length} {replies.length === 1 ? 'reply' : 'replies'}
        </h2>
        <button type="button" onClick={() => bus.actions.follow({ thread: id, on: !following })} aria-pressed={following} data-testid="follow" className="ml-auto rounded-md border px-2 py-0.5 text-xs hover:bg-accent">
          {following ? 'Following' : 'Follow'}
        </button>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto pb-2" data-pane-scroll>
      <ol ref={list} data-testid="conversation">
        {root ? (
          <li key={root.id} data-id={root.id} className="border-b pb-2">
            <MessageItem message={root} editing={editing === root.id} onEditing={(on) => setEditing(on ? root.id : null)} />
          </li>
        ) : null}
        {replies.map((message, at) => {
          const previous = at > 0 ? replies[at - 1]! : null
          const grouped = previous !== null && !previous.deleted && previous.by.actor === message.by.actor && Date.parse(message.createdAt) - Date.parse(previous.createdAt) < 5 * 60_000
          return (
            <li key={message.pending ?? message.id} data-id={message.id} data-pending={message.pending ? 'yes' : undefined}>
              <MessageItem message={message} grouped={grouped} editing={editing === message.id} onEditing={(on) => setEditing(on ? message.id : null)} />
            </li>
          )
        })}
      </ol>
      </div>
      <div className="shrink-0 px-4 pt-2 pb-4">
        <Composer place={'thread:' + id} label="Reply" placeholder="Reply…" onSend={(text) => bus.actions.post({ re: id, text })} onEditLast={editLast} />
      </div>
    </section>
  )
}

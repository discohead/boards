// A channel, as Slack shows one: its threads' roots oldest at the top and newest at the bottom, each
// with its thread's replies, and a box to start one. The list is virtual in chat mode: it starts at
// the bottom, follows new posts only while you're at the bottom, keeps what you're reading still
// when older pages load above it (scrolling up reads them), and marks the channel read while it's
// in view. A "New" line sits above the first root that came after you last read here.
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { useLiveQuery } from '@tanstack/react-db'
import { eq } from '@tanstack/db'
import { useVirtualizer } from '@tanstack/react-virtual'
import { Hash, MessageSquare } from 'lucide-react'
import { NewEventsPill } from '@/components/system'
import { useBus, type Message, type Thread } from '@/data'
import { useOpenThread } from '@/shell/open-thread'
import { channelKey } from '@/data/unread'
import { Composer } from './composer.tsx'
import { MessageItem } from './message.tsx'

/** The first render (the server's, and hydration's) shows this many of the newest, unvirtualized. */
const FIRST = 30
/** Roots by one author within this long of each other share a header. */
const GROUP_MS = 5 * 60_000

type Item = { key: string; thread: Thread; root: Message; grouped: boolean; fresh: boolean }

const order = (thread: Thread) => (thread.root.pending ? Number.MAX_SAFE_INTEGER : Number(thread.id))

export function ChannelView({ channel }: { channel: string }) {
  const bus = useBus()
  const { open, thread: openId } = useOpenThread()
  const { data: threads } = useLiveQuery({ query: (q) => q.from({ thread: bus.threads }).where(({ thread }) => eq(thread.channel, channel)) })
  // A root as the messages collection has it carries a write that hasn't settled yet (an edit, a reaction).
  const { data: messages } = useLiveQuery({ query: (q) => q.from({ message: bus.messages }).where(({ message }) => eq(message.channel, channel)) })
  const { data: counts } = useLiveQuery({ query: (q) => q.from({ row: bus.unread }).where(({ row }) => eq(row.channel, channel)) })
  const byId = useMemo(() => new Map(messages.map((message) => [message.id, message])), [messages])
  const repliesOf = useMemo(() => {
    const map = new Map<string, Message[]>()
    for (const message of messages) if (message.re) map.set(message.re, [...(map.get(message.re) ?? []), message])
    return map
  }, [messages])
  const unreadOf = useMemo(() => new Map(counts.filter((row) => row.kind === 'thread').map((row) => [row.thread!, row.unread])), [counts])
  const channelRow = counts.find((row) => row.key === channelKey(channel))

  // Where you'd read up to when you came in: the "New" line goes after it.
  const [readAtOpen, setReadAtOpen] = useState<{ channel: string; read: string | null } | null>(null)
  useEffect(() => {
    if (readAtOpen?.channel !== channel && bus.unread.status === 'ready') setReadAtOpen({ channel, read: (channelRow?.unread ?? 0) > 0 ? (channelRow?.read ?? '0') : null })
  }, [channel, channelRow, readAtOpen?.channel, bus.unread.status])

  const items = useMemo(() => {
    const sorted = [...threads].sort((a, b) => order(a) - order(b))
    const me = bus.runtime.me.actor
    const newFrom = readAtOpen?.channel === channel && readAtOpen.read !== null ? Number(readAtOpen.read) : null
    let marked = false
    return sorted.map((thread, at): Item => {
      const root = byId.get(thread.id) ?? thread.root
      const before = at > 0 ? sorted[at - 1]! : null
      const previous = before ? (byId.get(before.id) ?? before.root) : null
      const fresh = !marked && newFrom !== null && !root.pending && Number(root.id) > newFrom && root.by.actor !== me
      if (fresh) marked = true
      const grouped = !fresh && previous !== null && !previous.deleted && !root.deleted && previous.by.actor === root.by.actor && (before?.replies ?? 0) === 0 && Date.parse(root.createdAt) - Date.parse(previous.createdAt) < GROUP_MS
      return { key: thread.root.pending ?? thread.id, thread, root, grouped, fresh }
    }).filter((item) => !(item.root.deleted && item.thread.replies === 0))
  }, [threads, byId, readAtOpen, channel, bus])

  // Older pages: where the next one back starts (null at the channel's first thread).
  const [older, setOlder] = useState<{ channel: string; at: string | null; loading: boolean } | null>(null)
  useEffect(() => {
    bus.runtime.viewing.add(channel)
    return () => void bus.runtime.viewing.delete(channel)
  }, [bus, channel])
  useEffect(() => {
    let live = true
    setOlder(null)
    void bus.openChannel(channel).then((page) => live && setOlder({ channel, at: page.older, loading: false }))
    return () => {
      live = false
    }
  }, [bus, channel])
  const loadOlder = () => {
    if (!older || older.channel !== channel || older.loading || older.at === null) return
    setOlder({ ...older, loading: true })
    void bus.openChannel(channel, { before: older.at }).then(
      (page) => setOlder((now) => (now?.channel === channel ? { channel, at: page.older, loading: false } : now)),
      () => setOlder((now) => (now?.channel === channel ? { ...now, loading: false } : now)),
    )
  }

  // Read while it's in view: on opening it, and as roots come while the tab is visible.
  const unread = (channelRow?.unread ?? 0) + (channelRow?.mentions ?? 0)
  useEffect(() => {
    if (bus.unread.status !== 'ready') return
    const mark = () => {
      if (document.visibilityState === 'visible') void bus.actions.markRead({ channel })
    }
    if (unread > 0 || channelRow === undefined) mark()
    document.addEventListener('visibilitychange', mark)
    return () => document.removeEventListener('visibilitychange', mark)
  }, [bus, channel, unread, bus.unread.status])

  // Others' roots that come in while you're here get one brief tint.
  const seen = useRef<Map<string, number> | null>(null)
  if (seen.current === null && items.length > 0) seen.current = new Map(items.map((item) => [item.key, 0]))
  const arrived = (item: Item) => {
    const known = seen.current
    if (!known) return false
    if (!known.has(item.key)) known.set(item.key, item.root.by.actor === bus.runtime.me.actor || item.root.pending ? 0 : Date.now())
    const at = known.get(item.key)!
    return at > 0 && Date.now() - at < 1000
  }

  // Thread dots show after hydration: an open thread marks itself read meanwhile (the route's code
  // can hydrate after the pane's), and the first render must match the server's.
  const [mounted, setMounted] = useState(false)
  useEffect(() => setMounted(true), [])

  const [editing, setEditing] = useState<string | null>(null)
  const editLast = () => {
    const mine = [...items].reverse().find((item) => item.root.by.actor === bus.runtime.me.actor && !item.root.deleted && !item.root.pending)
    if (mine) setEditing(mine.root.id)
  }

  return (
    <div className="flex h-full flex-col">
      <header className="flex shrink-0 items-center border-b px-4 pt-5 pb-2">
        <h1 className="flex items-center gap-1.5 text-xl font-semibold tracking-tight">{channel.startsWith('dm/') ? <MessageSquare size={16} strokeWidth={1.5} aria-hidden /> : <Hash size={16} strokeWidth={1.5} aria-hidden />}{channel.startsWith('dm/') ? channel.slice(3) : channel}</h1>
      </header>
      <History
        key={channel}
        items={items}
        hasOlder={older?.channel === channel && older.at !== null}
        loading={older?.loading ?? false}
        onOlder={loadOlder}
        render={(item) => (
          <>
            {item.fresh ? <NewLine /> : null}
            <MessageItem
              message={item.root}
              grouped={item.grouped}
              thread={item.thread}
              replies={repliesOf.get(item.thread.id)}
              unreadReplies={mounted ? unreadOf.get(item.thread.id) : undefined}
              arrive={arrived(item)}
              onOpenThread={() => open(item.thread.id)}
              editing={editing === item.root.id}
              onEditing={(on) => setEditing(on ? item.root.id : null)}
            />
          </>
        )}
        opened={openId}
      />
      <div className="shrink-0 px-4 pb-4">
        <Composer place={'channel:' + channel} label={'Message #' + channel} placeholder={'Message #' + channel} onSend={(text) => bus.actions.post({ channel, text })} onEditLast={editLast} autoFocus />
      </div>
    </div>
  )
}

function NewLine() {
  return (
    <div className="flex items-center gap-2 px-4 py-1 text-xs font-semibold text-destructive" data-testid="new-line" role="separator" aria-label="New messages">
      <span className="h-px flex-1 bg-destructive/40" />
      New
    </div>
  )
}

function History({ items, hasOlder, loading, onOlder, render, opened }: { items: Item[]; hasOlder: boolean; loading: boolean; onOlder: () => void; render: (item: Item) => React.ReactNode; opened: string | null }) {
  const scroller = useRef<HTMLDivElement>(null)
  const [mounted, setMounted] = useState(false)
  useEffect(() => setMounted(true), [])
  const virtualizer = useVirtualizer({
    count: items.length,
    getScrollElement: () => scroller.current,
    estimateSize: () => 64,
    getItemKey: (index) => items[index]!.key,
    overscan: 10,
    anchorTo: 'end',
    followOnAppend: true,
    enabled: mounted,
  })
  // Start at the bottom, once.
  const started = useRef(false)
  useLayoutEffect(() => {
    if (!mounted || started.current || items.length === 0) return
    started.current = true
    virtualizer.scrollToEnd()
  }, [mounted, items.length, virtualizer])
  // Your own post always goes to the bottom, wherever you were.
  const last = items.at(-1)
  const lastMine = last?.root.pending
  useEffect(() => {
    if (lastMine) virtualizer.scrollToEnd()
  }, [lastMine, virtualizer])
  // Below the fold and not following: a pill says new posts came.
  const [below, setBelow] = useState(0)
  const seenLast = useRef(last?.key)
  const atEnd = mounted ? virtualizer.isAtEnd(80) : true
  useEffect(() => {
    if (atEnd) {
      setBelow(0)
      seenLast.current = last?.key
    } else if (last && last.key !== seenLast.current) {
      seenLast.current = last.key
      setBelow((n) => n + 1)
    }
  }, [atEnd, last?.key])
  const virtual = virtualizer.getVirtualItems()
  // Near the top: read the page before.
  const first = virtual[0]?.index ?? 0
  useEffect(() => {
    if (mounted && started.current && hasOlder && !loading && first <= 3) onOlder()
  }, [mounted, first, hasOlder, loading])

  return (
    <div className="relative min-h-0 flex-1">
      <div ref={scroller} className="h-full overflow-y-auto" data-testid="history" data-opened={opened ?? undefined}>
        {hasOlder || loading ? <div className="py-2 text-center text-xs text-muted-foreground">{loading ? 'Loading older threads…' : ' '}</div> : <ChannelStart empty={items.length === 0} />}
        {mounted ? (
          <ul style={{ height: virtualizer.getTotalSize(), position: 'relative' }} data-testid="threads">
            {virtual.map((row) => (
              <li key={row.key} data-index={row.index} data-id={items[row.index]!.root.id} data-pending={items[row.index]!.root.pending ? 'yes' : undefined} ref={virtualizer.measureElement} className="hover:z-10 focus-within:z-10 has-[[role=menu]]:z-20 has-[[role=alertdialog]]:z-20" style={{ position: 'absolute', top: 0, left: 0, width: '100%', transform: 'translateY(' + row.start + 'px)' }}>
                {render(items[row.index]!)}
              </li>
            ))}
          </ul>
        ) : (
          <ul data-testid="threads">
            {items.slice(-FIRST).map((item) => (
              <li key={item.key} data-id={item.root.id} data-pending={item.root.pending ? 'yes' : undefined}>
                {render(item)}
              </li>
            ))}
          </ul>
        )}
        <div className="h-2" />
      </div>
      {below > 0 ? (
        <div className="absolute bottom-2 left-1/2 -translate-x-1/2" data-testid="new-below">
          <NewEventsPill count={below} onClick={() => virtualizer.scrollToEnd({ behavior: 'smooth' })} />
        </div>
      ) : null}
    </div>
  )
}

function ChannelStart({ empty }: { empty: boolean }) {
  return <div className="px-4 pt-6 pb-2 text-sm text-muted-foreground">{empty ? 'Nothing here yet. Start a thread below.' : 'This is the start of the channel.'}</div>
}

// The inbox (design/workbus.md §6.1): everything waiting on the principal, in one list. Each item
// opens in the thread pane and is answered there. E marks it done (read, through the board's read
// state); replying in its thread marks it read up to the reply; ⌘↵ answers a held task (unblock) or
// applies a proposal. The list never moves the selected item: one that leaves stays, faded, until
// the selection moves on.
import { useEffect, useMemo, useRef, useState } from 'react'
import { createFileRoute } from '@tanstack/react-router'
import { useLiveQuery } from '@tanstack/react-db'
import { useHotkey } from '@tanstack/react-hotkeys'
import { AtSignIcon, GitBranchIcon, HandIcon, MessageSquareIcon } from 'lucide-react'
import { useBus, type Message } from '@/data'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import { useOpenThread } from '@/shell/open-thread'
import { holdLabel } from '@/task/model'
import { useMe } from '@/task/me'
import { useTasks } from '@/task/use-tasks'
import { useActorNames } from '@/task/actors'
import { holdSelected } from '@/task/hold'
import { ago } from '@/task/time'
import { inboxItems, type InboxItem, type Reason } from '@/inbox/items'
import { useReach } from '@/inbox/reach'

export const Route = createFileRoute('/')({ component: Inbox })

function Inbox() {
  const bus = useBus()
  const me = useMe()
  const reach = useReach()
  const tasks = useTasks()
  const name = useActorNames()
  const { thread: openId, open } = useOpenThread()
  const { data: docs } = useLiveQuery({ query: (q) => q.from({ doc: bus.docs }) })
  const docPath = (id: string) => docs.find((doc) => doc.id === id)?.path ?? 'doc #' + id
  const { data: all } = useLiveQuery({ query: (q) => q.from({ message: bus.messages }) })
  const messages = useMemo(() => new Map(all.map((message) => [message.id, message as Message])), [all])
  const items = useMemo(() => (me && reach.ready ? inboxItems({ reach, tasks, messages, me: me.actor, can: me.can }) : []), [me, reach, tasks, messages])

  // Answered: my newest message in a thread with something unread is after what's unread, so the
  // thread is read up to it.
  useEffect(() => {
    if (!me) return
    for (const row of reach.threads.values()) {
      if (row.unread <= 0) continue
      let mine: Message | null = null
      for (const message of messages.values()) if (message.re === row.thread && message.by.actor === me.actor && !message.pending && (!mine || Number(message.id) > Number(mine.id))) mine = message
      const theirs = reach.reached.filter((message) => message.re === row.thread && message.by.actor !== me.actor).at(-1)
      if (mine && (!theirs || Number(mine.id) > Number(theirs.id))) void reach.markRead({ thread: row.thread }, mine.id)
    }
  }, [me, reach, messages])

  const [selected, setSelected] = useState<string | null>(null)
  const shown = useRef<{ key: string; group: string }[]>([])
  const last = useRef(new Map<string, InboxItem>())
  const next = items.map((one) => ({ key: one.thread, group: '', one }))
  for (const one of items) last.current.set(one.thread, one)
  const kept = selected ? last.current.get(selected) : undefined
  const list = holdSelected(shown.current, next, selected, kept ? { key: kept.thread, group: '', one: kept } : undefined)
  shown.current = list
  const live = new Set(items.map((one) => one.thread))

  const move = (by: number) => {
    if (!list.length) return
    const at = selected ? list.findIndex((row) => row.key === selected) : -1
    const to = at < 0 ? (by > 0 ? 0 : list.length - 1) : Math.max(0, Math.min(list.length - 1, at + by))
    setSelected(list[to]!.key)
    document.querySelector('[data-item="' + list[to]!.key + '"]')?.scrollIntoView({ block: 'nearest' })
  }
  const current = list.find((row) => row.key === selected)?.one
  const done = (one: InboxItem) => void reach.markRead({ thread: one.thread })
  const approve = (one: InboxItem) => {
    const task = one.task
    if (!task) return
    if (one.reasons.some((reason) => reason.kind === 'held')) bus.actions.task.unblock({ id: task.id })
    else if (one.reasons.some((reason) => reason.kind === 'proposal')) bus.actions.task.complete({ id: task.id })
  }
  useHotkey('J', () => move(1))
  useHotkey('K', () => move(-1))
  useHotkey('ArrowDown', () => move(1))
  useHotkey('ArrowUp', () => move(-1))
  useHotkey('Enter', () => selected && open(selected), { enabled: selected !== null })
  useHotkey('E', () => current && done(current), { enabled: !!current })
  useHotkey('Mod+Enter', () => current && approve(current), { enabled: !!current?.task })

  return (
    <div className="flex h-full flex-col">
      <header className="flex items-baseline gap-2 border-b px-4 pt-4 pb-2">
        <h1 className="text-lg font-semibold">Inbox</h1>
        <span className="font-mono text-xs text-muted-foreground tabular-nums" data-testid="inbox-count">
          {items.length}
        </span>
        <span className="ml-auto text-xs text-muted-foreground">
          <Kbd>J</Kbd> <Kbd>K</Kbd> move · <Kbd>↵</Kbd> open · <Kbd>E</Kbd> done · <Kbd>⌘↵</Kbd> approve
        </span>
      </header>
      <ul data-testid="inbox" aria-label="Inbox" className="min-h-0 flex-1 overflow-y-auto">
        {!reach.ready ? <li className="p-8 text-sm text-muted-foreground">Reading what's waiting on you…</li> : list.length === 0 ? <li className="p-8 text-sm text-muted-foreground">Nothing is waiting on you.</li> : null}
        {list.map(({ key, one }) => (
          <li
            key={key}
            data-item={key}
            data-kinds={one.reasons.map((reason) => reason.kind).join(' ')}
            aria-selected={selected === key}
            data-gone={live.has(key) ? undefined : 'yes'}
            onClick={() => {
              setSelected(key)
              open(key)
            }}
            className={cn('flex cursor-default items-start gap-3 border-b px-4 py-2 text-sm hover:bg-muted/50', selected === key && 'bg-muted', openId === key && 'bg-accent', !live.has(key) && 'opacity-50')}
          >
            <ReasonIcon reason={one.reasons[0]!} />
            <div className="min-w-0 flex-1">
              <div className="flex items-baseline gap-2">
                <span className={cn('truncate', live.has(key) && 'font-medium')}>{title(one)}</span>
                {one.reasons.map((reason, at) => (
                  <Kind key={at} reason={reason} />
                ))}
              </div>
              <div className="truncate text-xs text-muted-foreground" suppressHydrationWarning>
                {detail(one, name, docPath)}
              </div>
            </div>
            <div className="flex shrink-0 flex-col items-end gap-1">
              <span className="font-mono text-xs text-muted-foreground tabular-nums">
                #{one.thread} · #{one.channel}
              </span>
              {one.reasons.some((reason) => reason.kind === 'reply' || reason.kind === 'mention') && live.has(key) ? (
                <Button
                  size="xs"
                  variant="ghost"
                  onClick={(event) => {
                    event.stopPropagation()
                    done(one)
                  }}
                >
                  Done
                </Button>
              ) : null}
            </div>
          </li>
        ))}
      </ul>
    </div>
  )
}

const title = (one: InboxItem) => ((one.root?.text ?? '').split('\n')[0] ?? '').replace(/^#+\s*/, '').replace(/@\[[^\]]*:([^\]:]+)\]/g, '@$1') || '#' + one.thread

function detail(one: InboxItem, name: (id: string) => string, docPath: (id: string) => string) {
  for (const reason of one.reasons) {
    if (reason.kind === 'held') return holdLabel(reason.hold) + ': ' + reason.reason
    if (reason.kind === 'proposal') return 'Proposes a change to ' + docPath(reason.doc) + '. Apply it, or drop it.'
    if (reason.kind === 'reply' && reason.latest) return '@' + name(reason.latest.by.actor) + ': ' + plain(reason.latest.text) + (reason.unread > 1 ? ' · ' + reason.unread + ' new' : '') + ' · ' + ago(reason.latest.createdAt)
    if (reason.kind === 'reply') return reason.unread + ' new'
    if (reason.kind === 'mention') return '@' + name(reason.latest.by.actor) + ' mentioned you · ' + ago(reason.latest.createdAt)
  }
  return ''
}
const plain = (text: string) => text.replace(/@\[[^\]]*:([^\]:]+)\]/g, '@$1').split('\n')[0]!

function ReasonIcon({ reason }: { reason: Reason }) {
  const Icon = reason.kind === 'held' ? HandIcon : reason.kind === 'proposal' ? GitBranchIcon : reason.kind === 'mention' || (reason.kind === 'reply' && reason.mentions > 0) ? AtSignIcon : MessageSquareIcon
  return <Icon className={cn('mt-0.5 size-4 shrink-0', reason.kind === 'held' ? 'text-primary' : 'text-muted-foreground')} aria-hidden />
}

/** The kind of an item, in mono on a tint: held kinds and proposals and mentions. */
function Kind({ reason }: { reason: Reason }) {
  const text = reason.kind === 'held' ? (reason.hold ?? 'held') : reason.kind === 'proposal' ? 'proposal' : reason.kind === 'mention' || (reason.kind === 'reply' && reason.mentions > 0) ? 'mention' : null
  if (!text) return null
  return <span className={cn('shrink-0 rounded-sm px-1 font-mono text-xs', reason.kind === 'held' ? 'bg-primary/10 text-primary' : 'bg-muted text-muted-foreground')}>{text}</span>
}

function Kbd({ children }: { children: string }) {
  return <kbd className="rounded-sm border px-1 font-mono text-xs">{children}</kbd>
}
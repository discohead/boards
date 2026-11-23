// The inbox (design/workbus.md §6.1): everything waiting on the principal, in one list. Each item
// opens in the thread pane and is answered there. E marks it done (read, through the board's read
// state); replying in its thread marks it read up to the reply; ⌘↵ answers a held task (unblock) or
// applies a proposal. The list never moves the selected item: one that leaves stays, faded, until
// the selection moves on.
import { Fragment, useEffect, useMemo, useRef, useState } from 'react'
import { createFileRoute } from '@tanstack/react-router'
import { useLiveQuery } from '@tanstack/react-db'
import { useHotkey } from '@tanstack/react-hotkeys'
import { MessageSquareIcon } from 'lucide-react'
import { Kbd, Kind, type KindName } from '@/components/system'
import { useBus } from '@/data'
import { named, summaryOf } from '@/data/text'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import { useOpenThread } from '@/shell/open-thread'
import { useActorNames } from '@/task/actors'
import { holdSelected } from '@/task/hold'
import type { InboxItem, Reason } from '@/inbox/items'
import { useInbox } from '@/inbox/use-inbox'
import { DateBar, ListPane } from '@/shell/list-pane'
import { Clock } from '@/shell/clock'

export const Route = createFileRoute('/')({ component: Inbox })

type Chip = 'all' | 'held' | 'unread'
const CHIPS: Record<Chip, Reason['kind'][]> = { all: [], held: ['held'], unread: ['reply'] }
const CHIP_LABEL: Record<Chip, string> = { all: 'All', held: 'Held', unread: 'Unread' }

function Inbox() {
  const bus = useBus()
  const { items: all, ready, markRead } = useInbox()
  // What reached me (each item's newest reply): one read, here, not for the sidebar.
  useEffect(() => void bus.openInbox().catch(() => {}), [bus])
  const name = useActorNames()
  const [chip, setChip] = useState<Chip>('all')
  const items = useMemo(() => all.filter((one) => chip === 'all' || one.reasons.some((reason) => CHIPS[chip].includes(reason.kind))), [all, chip])
  const { thread: openId, open } = useOpenThread()
  const { data: docs } = useLiveQuery({ query: (q) => q.from({ doc: bus.docs }) })
  const docPath = (id: string) => docs.find((doc) => doc.id === id)?.path ?? 'doc #' + id

  // By day, newest first; the selected item keeps its day and its place in it while the list changes.
  const [selected, setSelected] = useState<string | null>(null)
  const shown = useRef<{ key: string; group: string }[]>([])
  const last = useRef(new Map<string, InboxItem>())
  const next = items.map((one) => ({ key: one.thread, group: dayOf(whenOf(one)), one }))
  for (const one of items) last.current.set(one.thread, one)
  const kept = selected ? last.current.get(selected) : undefined
  const list = holdSelected(shown.current, next, selected, kept ? { key: kept.thread, group: dayOf(whenOf(kept)), one: kept } : undefined)
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
  const done = (one: InboxItem) => void markRead({ thread: one.thread })
  const approve = (one: InboxItem) => {
    const task = one.task
    if (!task) return
    if (one.reasons.some((reason) => reason.kind === 'held')) bus.actions.task.unblock({ id: task.id, ...(one.reasons.some((reason) => reason.kind === 'held' && reason.hold === 'approval') ? { decision: 'approved' as const } : {}) })
    else if (one.reasons.some((reason) => reason.kind === 'proposal')) bus.actions.task.complete({ id: task.id })
  }
  useHotkey('J', () => move(1), { meta: { name: 'Next item', group: 'Inbox' } })
  useHotkey('K', () => move(-1), { meta: { name: 'Previous item', group: 'Inbox' } })
  useHotkey('ArrowDown', () => move(1))
  useHotkey('ArrowUp', () => move(-1))
  useHotkey('Enter', () => selected && open(selected), { enabled: selected !== null })
  useHotkey('E', () => current && done(current), { enabled: !!current, meta: { name: 'Mark done', group: 'Inbox' } })
  useHotkey('Mod+Enter', () => current && approve(current), { enabled: !!current?.task, meta: { name: 'Approve: unblock, or apply the proposal', group: 'Inbox' } })

  return (
    <ListPane
      title="Inbox"
      chips={(Object.keys(CHIPS) as Chip[]).map((key) => ({ label: CHIP_LABEL[key], count: key === 'all' ? all.length : all.filter((one) => one.reasons.some((reason) => CHIPS[key].includes(reason.kind))).length, active: chip === key, onClick: () => setChip(key) }))}
      actions={
        <span className="font-mono text-xs text-muted-foreground">
          <Kbd>E</Kbd> done <Kbd>⌘↵</Kbd> approve
        </span>
      }
    >
      <div data-testid="inbox" data-count={items.length} role="list" aria-label="Inbox" className="h-full overflow-y-auto">
        {!ready ? <p className="p-8 text-sm text-muted-foreground">Reading what's waiting on you…</p> : list.length === 0 ? <p className="p-8 text-sm text-muted-foreground">Nothing is waiting on you.</p> : null}
        {list.map(({ key, group, one }, at) => (
          <Fragment key={key}>
            {at === 0 || list[at - 1]!.group !== group ? <DateBar day={group} count={list.filter((row) => row.group === group).length} /> : null}
            <div
              role="listitem"
              data-item={key}
              data-kinds={one.reasons.map((reason) => reason.kind).join(' ')}
              aria-selected={selected === key}
              data-gone={live.has(key) ? undefined : 'yes'}
              onClick={() => {
                setSelected(key)
                open(key)
              }}
              className={cn('group flex cursor-default flex-col gap-0.5 border-b px-4 py-2 text-sm hover:bg-muted/50', selected === key && 'bg-muted', openId === key && 'bg-accent', !live.has(key) && 'opacity-50')}
            >
              <div className="flex items-center justify-between gap-2">
                <span className="flex items-center gap-1.5">
                  {one.reasons.map((reason, n) => (
                    <ItemKind key={n} reason={reason} />
                  ))}
                </span>
                <span className="font-mono text-xs text-muted-foreground tabular-nums">
                  <Clock at={whenOf(one)} />
                </span>
              </div>
              <div className={cn('truncate', live.has(key) && 'font-medium')}>{title(one, named(name))}</div>
              <div className="flex items-center gap-2">
                <span className="min-w-0 flex-1 truncate font-mono text-xs text-muted-foreground">
                  @{name(whoOf(one))} · {one.channel}
                  <span className="font-sans"> {detail(one, docPath, named(name))}</span>
                </span>
                {one.reasons.some((reason) => reason.kind === 'reply') && live.has(key) ? (
                  <Button
                    size="xs"
                    variant="ghost"
                    className="opacity-0 group-hover:opacity-100"
                    onClick={(event) => {
                      event.stopPropagation()
                      done(one)
                    }}
                  >
                    Done
                  </Button>
                ) : null}
              </div>
            </div>
          </Fragment>
        ))}
      </div>
    </ListPane>
  )
}

/** Its thread's first line: the root's, or, when the root isn't in memory, the newest reply's (opening it reads the thread). */
type Actors = ReturnType<typeof named>
const title = (one: InboxItem, actors: Actors) => summaryOf(one.root?.text ?? latestOf(one)?.text ?? '', actors) || 'Thread #' + one.thread

/** The message that put it here: the newest reply or mention, else its root. */
const latestOf = (one: InboxItem) => {
  for (const reason of one.reasons) if (reason.kind === 'reply' && reason.latest) return reason.latest
  return one.root
}
const whenOf = (one: InboxItem) => latestOf(one)?.createdAt ?? new Date(0).toISOString()
const whoOf = (one: InboxItem) => latestOf(one)?.by.actor ?? one.task?.task.by ?? ''

/** Today, Yesterday, or the date, in the reader's own zone. */
function dayOf(iso: string) {
  const date = new Date(iso)
  const today = new Date()
  const start = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime()
  const days = Math.round((start(today) - start(date)) / 86_400_000)
  return days === 0 ? 'Today' : days === 1 ? 'Yesterday' : date.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })
}

/** What it asks of me, after who and where. */
function detail(one: InboxItem, docPath: (id: string) => string, actors: Actors) {
  for (const reason of one.reasons) {
    if (reason.kind === 'held') return '· ' + reason.reason
    if (reason.kind === 'proposal') return '· proposes a change to ' + docPath(reason.doc)
    if (reason.kind === 'reply' && reason.latest) return '· ' + summaryOf(reason.latest.text, actors) + (reason.unread > 1 ? ' (' + reason.unread + ' new)' : '')
  }
  return ''
}

/** The kind of an item, as the prototype's inbox row draws it: the system's Kind, plain (its icon and word). A plain reply has no system kind. */
function ItemKind({ reason }: { reason: Reason }) {
  const mention = reason.kind === 'reply' && reason.mentions > 0
  if (reason.kind === 'held') return reason.hold && HELD_KINDS.includes(reason.hold) ? <Kind plain kind={reason.hold as KindName} /> : <Kind plain kind="approval">{reason.hold ?? 'held'}</Kind>
  if (reason.kind === 'proposal') return <Kind plain kind="proposal" />
  if (mention) return <Kind plain kind="mention" />
  return (
    <span className="inline-flex items-center gap-1 font-mono text-mono-label text-muted-foreground">
      <MessageSquareIcon size={13} strokeWidth={1.5} aria-hidden />
      Reply
    </span>
  )
}
const HELD_KINDS: readonly string[] = ['approval', 'decision', 'budget', 'review']

// The inbox (design/workbus.md §6.1): everything waiting on the principal, in one list. Each item
// opens in the thread pane and is answered there. E marks it done (read, through the board's read
// state); replying in its thread marks it read up to the reply; ⌘↵ answers a held task (unblock) or
// applies a proposal. The list never moves the selected item: one that leaves stays, faded, until
// the selection moves on.
import { useMemo, useRef, useState } from 'react'
import { createFileRoute } from '@tanstack/react-router'
import { useLiveQuery } from '@tanstack/react-db'
import { useHotkey } from '@tanstack/react-hotkeys'
import { AtSignIcon, GitBranchIcon, HandIcon, MessageSquareIcon } from 'lucide-react'
import { useBus } from '@/data'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import { useOpenThread } from '@/shell/open-thread'
import { holdLabel } from '@/task/model'
import { useActorNames } from '@/task/actors'
import { holdSelected } from '@/task/hold'
import { ago } from '@/task/time'
import type { InboxItem, Reason } from '@/inbox/items'
import { useInbox } from '@/inbox/use-inbox'
import { ListPane } from '@/shell/list-pane'

export const Route = createFileRoute('/')({ component: Inbox })

type Chip = 'all' | 'held' | 'mentions' | 'proposals'
const CHIPS: Record<Chip, Reason['kind'][]> = { all: [], held: ['held'], mentions: ['mention', 'reply'], proposals: ['proposal'] }
const CHIP_LABEL: Record<Chip, string> = { all: 'All', held: 'Held', mentions: 'Replies and mentions', proposals: 'Proposals' }

function Inbox() {
  const bus = useBus()
  const { items: all, ready, markRead } = useInbox()
  const name = useActorNames()
  const [chip, setChip] = useState<Chip>('all')
  const items = useMemo(() => all.filter((one) => chip === 'all' || one.reasons.some((reason) => CHIPS[chip].includes(reason.kind))), [all, chip])
  const { thread: openId, open } = useOpenThread()
  const { data: docs } = useLiveQuery({ query: (q) => q.from({ doc: bus.docs }) })
  const docPath = (id: string) => docs.find((doc) => doc.id === id)?.path ?? 'doc #' + id

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
  const done = (one: InboxItem) => void markRead({ thread: one.thread })
  const approve = (one: InboxItem) => {
    const task = one.task
    if (!task) return
    if (one.reasons.some((reason) => reason.kind === 'held')) bus.actions.task.unblock({ id: task.id })
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
        <span className="text-xs text-muted-foreground">
          <Kbd>E</Kbd> done · <Kbd>⌘↵</Kbd> approve
        </span>
      }
    >
      <ul data-testid="inbox" data-count={items.length} aria-label="Inbox" className="h-full overflow-y-auto">
        {!ready ? <li className="p-8 text-sm text-muted-foreground">Reading what's waiting on you…</li> : list.length === 0 ? <li className="p-8 text-sm text-muted-foreground">Nothing is waiting on you.</li> : null}
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
    </ListPane>
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
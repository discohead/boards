// A task list (design/workbus.md §9.3, Linear's): TanStack Table v9 sorts and filters the rows, and
// the list groups them by state, or lays them out as a board by state. j and k move the selection,
// Enter opens it in the thread pane (?thread=<id>). Rows update live, and the selected row never
// moves under the cursor: it holds its place (hold.ts), and the list scrolls to keep it where it was.
import { initialsFor } from '@/seats/initials'
import { useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import {
  columnFacetingFeature,
  columnFilteringFeature,
  createColumnHelper,
  createFacetedRowModel,
  createFacetedUniqueValues,
  createFilteredRowModel,
  createSortedRowModel,
  rowSortingFeature,
  sortFn_alphanumeric,
  sortFn_basic,
  tableFeatures,
  useTable,
  type ColumnFiltersState,
  type Row as TableRow,
  type SortingState,
} from '@tanstack/react-table'
import { useHotkey } from '@tanstack/react-hotkeys'
import { ChevronDownIcon, ArrowDownIcon, ArrowUpIcon, LayoutGridIcon, ListIcon } from 'lucide-react'
import type { Chip } from '@/shell/list-pane'
import { NewTask } from './new-task.tsx'
import { Button } from '@/components/ui/button'
import { DropdownMenu, DropdownMenuCheckboxItem, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuTrigger } from '@/components/ui/dropdown-menu'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow as Tr } from '@/components/ui/table'
import { cn } from '@/lib/utils'
import { useOpenThread } from '@/shell/open-thread'
import { holdSelected } from './hold.ts'
import { taskState, type ShownState } from '@/data'
import { assigneeOf, holdOf, shownLabels, SHOWN, SHOWN_LABEL, stateOf, type Task, type TaskState } from './model.ts'
import { useActorNames } from './actors.ts'
import { named, summaryOf } from '@/data/text'
import { BoardCard, IssueRow, Kind, Label, TaskState as TaskGlyph, type KindName } from '@/components/system'
import { useActorKinds } from './actors.ts'

/** A row as the table reads it: plain values per column, so sorting and filtering compare them. */
export type TaskRow = {
  id: string
  title: string
  state: TaskState
  /** The state as the app shows it (taskState): the group, and its word. */
  shown: ShownState
  word: string
  assignee: string
  assigneeName: string
  owner: string
  ownerName: string
  channel: string
  labels: string[]
  /** The cursor of its last change (its message's version): newer is more recent, and it's what the list shows. */
  updated: number
  hold: string | null
  pending: boolean
  task: Task
}

/** What a list shows: filters (each a set of values; none is everything), its order, and its layout. */
export type ListView = {
  state: string[]
  owner: string[]
  assignee: string[]
  channel: string[]
  label: string[]
  sort: { id: string; desc: boolean }
  group: boolean
  layout: 'list' | 'board'
}

const features = tableFeatures({
  rowSortingFeature,
  sortedRowModel: createSortedRowModel(),
  sortFns: { alphanumeric: sortFn_alphanumeric, basic: sortFn_basic },
  columnFilteringFeature,
  filteredRowModel: createFilteredRowModel(),
  columnFacetingFeature,
  facetedRowModel: createFacetedRowModel(),
  facetedUniqueValues: createFacetedUniqueValues(),
})

type R = TableRow<typeof features, TaskRow>
/** In any of the chosen values; a channel ending in / is that channel and its subtree (a team's queue). */
const anyOf = (row: R, id: string, chosen: string[]) => {
  const value = row.getValue(id) as string | string[]
  const values = Array.isArray(value) ? value : [value]
  return chosen.some((want) => (want.endsWith('/') ? values.some((one) => one === want.slice(0, -1) || one.startsWith(want)) : values.includes(want)))
}
anyOf.autoRemove = (value: unknown) => !Array.isArray(value) || value.length === 0

const rank = (state: ShownState) => SHOWN.indexOf(state)
const helper = createColumnHelper<typeof features, TaskRow>()
const columns = helper.columns([
  helper.accessor('id', { header: '#', sortFn: (a, b) => Number(a.original.id) - Number(b.original.id) }),
  helper.accessor('title', { header: 'Title', sortFn: 'alphanumeric' }),
  helper.accessor('state', { header: 'State', filterFn: anyOf, sortFn: (a, b) => rank(a.original.shown) - rank(b.original.shown) }),
  helper.accessor('assignee', { header: 'Assignee', filterFn: anyOf, sortFn: (a, b) => a.original.assigneeName.localeCompare(b.original.assigneeName) }),
  helper.accessor('owner', { header: 'Owner', filterFn: anyOf, sortFn: (a, b) => a.original.ownerName.localeCompare(b.original.ownerName) }),
  helper.accessor('channel', { header: 'Channel', filterFn: anyOf, sortFn: 'alphanumeric' }),
  helper.accessor('labels', { header: 'Labels', filterFn: anyOf, enableSorting: false }),
  helper.accessor('updated', { header: 'Updated', sortFn: 'basic', sortDescFirst: true }),
])

const FILTERED = ['state', 'owner', 'assignee', 'channel', 'label'] as const
/** The menus: state is the list pane's chips. */
const MENUS = ['owner', 'assignee', 'channel', 'label'] as const
const COLUMN_OF = { state: 'state', owner: 'owner', assignee: 'assignee', channel: 'channel', label: 'labels' } as const

/** Task rows from tasks, named. */
export function useTaskRows(tasks: Task[]): TaskRow[] {
  const name = useActorNames()
  return useMemo(
    () =>
      tasks.map((task) => {
        const assignee = assigneeOf(task) ?? ''
        return {
          id: task.id,
          title: summaryOf(task.text, named(name)) || '(no text)',
          state: stateOf(task),
          shown: taskState(task.task).state,
          word: taskState(task.task).waitsOn?.length ? 'waits on ' + taskState(task.task).waitsOn!.map((id) => '#' + id).join(' ') : taskState(task.task).word,
          assignee,
          assigneeName: assignee ? name(assignee) : '',
          owner: task.task.owner ?? '',
          ownerName: name(task.task.owner),
          channel: task.channel,
          labels: shownLabels(task.labels).map(([key, value]) => key + '=' + value),
          updated: task.version || Number.MAX_SAFE_INTEGER,
          hold: holdOf(task)?.kind ?? null,
          pending: !!task.pending,
          task,
        }
      }),
    [tasks, name],
  )
}

type Item = { key: string; group: string; row: TaskRow }

export function TaskList({ rows, view, onView, empty, label }: { rows: TaskRow[]; view: ListView; onView: (view: ListView) => void; empty?: ReactNode; label: string }) {
  const { thread, open } = useOpenThread()
  const columnFilters = useMemo<ColumnFiltersState>(() => FILTERED.filter((key) => view[key].length > 0).map((key) => ({ id: COLUMN_OF[key], value: view[key] })), [view])
  const sorting = useMemo<SortingState>(() => [view.sort], [view.sort])
  const table = useTable({
    features,
    columns,
    data: rows,
    getRowId: (row) => row.id,
    state: { columnFilters, sorting },
    onSortingChange: (updater) => {
      const next = typeof updater === 'function' ? updater(sorting) : updater
      onView({ ...view, sort: next[0] ?? { id: 'updated', desc: true } })
    },
    onColumnFiltersChange: () => {},
    enableSortingRemoval: false,
  })
  const sorted = table.getRowModel().rows.map((row) => row.original)

  // What's shown: grouped by state (in STATES order) or not, with the selected row held in place.
  const [selected, setSelected] = useState<string | null>(null)
  const shown = useRef<Item[]>([])
  const byId = useMemo(() => new Map(rows.map((row) => [row.id, row])), [rows])
  const grouped = view.group || view.layout === 'board'
  const next: Item[] = (grouped ? [...sorted].sort((a, b) => rank(a.shown) - rank(b.shown)) : sorted).map((row) => ({ key: row.id, group: grouped ? row.shown : '', row }))
  const kept = selected ? byId.get(selected) : undefined
  const items = holdSelected(shown.current, next, selected, kept ? { key: kept.id, group: grouped ? kept.shown : '', row: kept } : undefined)
  shown.current = items
  const gone = new Set(items.filter((item) => !next.some((one) => one.key === item.key)).map((item) => item.key))

  // Keep the selected row where it is on screen across live changes (not across j and k: those scroll to it).
  const scroller = useRef<HTMLDivElement>(null)
  const anchor = useRef<{ key: string; top: number } | null>(null)
  const moved = useRef(false)
  useLayoutEffect(() => {
    const box = scroller.current
    if (!box || !selected) return void (anchor.current = null)
    const element = box.querySelector<HTMLElement>('[data-row="' + selected + '"]')
    if (!element) return
    const top = element.getBoundingClientRect().top
    if (moved.current) {
      element.scrollIntoView({ block: 'nearest' })
      moved.current = false
    } else if (anchor.current?.key === selected && anchor.current.top !== top) box.scrollTop += top - anchor.current.top
    anchor.current = { key: selected, top: element.getBoundingClientRect().top }
  })

  // Narrow (beside an open thread): one line a task. Wide: the table, its columns by width.
  const [narrow, setNarrow] = useState(false)
  useEffect(() => {
    const box = scroller.current
    if (!box || typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(([entry]) => setNarrow((entry?.contentRect.width ?? 1000) < 560))
    observer.observe(box)
    return () => observer.disconnect()
  }, [])

  const order = items.map((item) => item.key)
  const move = (by: number) => {
    if (order.length === 0) return
    const at = selected ? order.indexOf(selected) : -1
    const to = at < 0 ? (by > 0 ? 0 : order.length - 1) : Math.max(0, Math.min(order.length - 1, at + by))
    moved.current = true
    setSelected(order[to]!)
  }
  useHotkey('J', () => move(1), { meta: { name: 'Next task', group: 'Task lists' } })
  useHotkey('K', () => move(-1), { meta: { name: 'Previous task', group: 'Task lists' } })
  useHotkey('ArrowDown', () => move(1))
  useHotkey('ArrowUp', () => move(-1))
  useHotkey('Enter', () => selected && open(selected), { enabled: selected !== null, meta: { name: 'Open in the thread pane', group: 'Task lists' } })

  const pick = (id: string) => {
    setSelected(id)
    open(id)
  }
  const filtering = FILTERED.some((key) => view[key].length > 0)

  return (
    <div className="flex h-full min-h-0 flex-col">
      <Toolbar table={table} view={view} onView={onView} rows={rows} count={next.length} />
      <div ref={scroller} data-testid="task-list" aria-label={label} className="@container min-h-0 flex-1 overflow-auto [overflow-anchor:none]">
        {items.length === 0 ? (
          <div className="p-8 text-sm text-muted-foreground">{filtering ? 'No tasks match these filters.' : (empty ?? 'No tasks.')}</div>
        ) : view.layout === 'board' ? (
          <Board items={items} selected={selected} openId={thread} gone={gone} onPick={pick} />
        ) : narrow ? (
          <ul aria-label={label}>
            {items.map((item, at) => (
              <Compact key={item.key} item={item} header={grouped && (at === 0 || items[at - 1]!.group !== item.group) ? item.group : null} count={items.filter((one) => one.group === item.group).length} selected={selected === item.key} opened={thread === item.key} gone={gone.has(item.key)} onPick={pick} />
            ))}
          </ul>
        ) : (
          <Table className="table-fixed">
            <TableHeader className="sticky top-0 z-10 bg-background">
              {table.getHeaderGroups().map((group) => (
                <Tr key={group.id}>
                  {group.headers.map((header) => (
                    <TableHead key={header.id} className={cn(WIDTH[header.column.id], header.column.getCanSort() && 'cursor-pointer select-none')} onClick={header.column.getToggleSortingHandler()} aria-sort={header.column.getIsSorted() ? (header.column.getIsSorted() === 'desc' ? 'descending' : 'ascending') : undefined}>
                      <span className="inline-flex items-center gap-1 text-xs text-muted-foreground">
                        <table.FlexRender header={header} />
                        {header.column.getIsSorted() === 'desc' ? <ArrowDownIcon className="size-3" /> : header.column.getIsSorted() === 'asc' ? <ArrowUpIcon className="size-3" /> : null}
                      </span>
                    </TableHead>
                  ))}
                </Tr>
              ))}
            </TableHeader>
            <TableBody>
              {items.map((item, at) => (
                <Line key={item.key} item={item} header={grouped && (at === 0 || items[at - 1]!.group !== item.group) ? item.group : null} count={items.filter((one) => one.group === item.group).length} selected={selected === item.key} opened={thread === item.key} gone={gone.has(item.key)} onPick={pick} />
              ))}
            </TableBody>
          </Table>
        )}
      </div>
    </div>
  )
}

const KINDS: readonly string[] = ['approval', 'decision', 'budget', 'review', 'proposal', 'mention']
/** A held task's kind as the system draws it, when it's one the system knows. */
const kindsOf = (row: TaskRow): KindName[] => (row.hold && KINDS.includes(row.hold) ? [row.hold as KindName] : row.task.labels['board.doc.proposal'] ? ['proposal'] : [])
const labelPairs = (row: TaskRow) => row.labels.map((label) => [label.slice(0, label.indexOf('=')), label.slice(label.indexOf('=') + 1)] as [string, string])
/** The state's glyph, with its word when the word says more than the state (waits on #12, canceled). */
function StateMark({ row }: { row: TaskRow }) {
  return <TaskGlyph state={row.shown} {...(row.word !== row.shown ? { label: row.word } : {})} muted={row.state === 'canceled'} />
}

/** One task on one line, for a narrow list: the system's IssueRow. */
function Compact({ item, header, count, selected, opened, gone, onPick }: { item: Item; header: string | null; count: number; selected: boolean; opened: boolean; gone: boolean; onPick: (id: string) => void }) {
  const row = item.row
  const avatar = useAssignee(row)
  return (
    <>
      {header !== null ? (
        <div role="rowgroup" data-group={header} className="flex items-center gap-2 border-b bg-sidebar px-3 py-1 font-mono text-mono-label text-muted-foreground">
          <TaskGlyph state={header as ShownState} />
          {SHOWN_LABEL[header as ShownState]}
          <span className="ml-auto">{count}</span>
        </div>
      ) : null}
      <IssueRow
        data-row={row.id}
        data-pending={row.pending ? 'yes' : undefined}
        cursor={row.pending ? 'sending…' : '#' + row.id}
        state={row.shown}
        title={row.title}
        kinds={kindsOf(row)}
        labels={labelPairs(row)}
        {...(avatar ? { assignee: avatar } : {})}
        updated={row.pending ? '' : '#' + row.updated}
        selected={selected}
        onClick={() => onPick(row.id)}
        className={cn(opened && !selected && 'bg-raised', (gone || row.pending) && 'opacity-60')}
      />
    </>
  )
}

/** The assignee as the system's Avatar: round for a person, square for an agent. */
function useAssignee(row: TaskRow) {
  const kindOf = useActorKinds()
  if (!row.assignee) return null
  return { kind: kindOf(row.assignee), initials: initialsFor(row.assignee, row.assigneeName), name: row.assigneeName }
}

// Beside an open thread the list is narrow: it keeps the cursor, title, state, and when; the rest
// come back as it widens (container queries on the list).
const WIDTH: Record<string, string> = { id: 'w-14', title: 'w-auto', state: 'w-24', assignee: 'hidden w-28 @2xl:table-cell', owner: 'hidden w-28 @4xl:table-cell', channel: 'hidden w-28 @3xl:table-cell', labels: 'hidden w-40 @5xl:table-cell', updated: 'w-20' }

function Line({ item, header, count, selected, opened, gone, onPick }: { item: Item; header: string | null; count: number; selected: boolean; opened: boolean; gone: boolean; onPick: (id: string) => void }) {
  const row = item.row
  return (
    <>
      {header !== null ? (
        <Tr data-group={header} className="bg-muted/40 hover:bg-muted/40">
          <TableCell colSpan={8} className="py-1.5 text-xs font-medium">
            <span className="inline-flex items-center gap-2">
              <TaskGlyph state={header as ShownState} />
              {SHOWN_LABEL[header as ShownState]}
              <span className="text-muted-foreground">{count}</span>
            </span>
          </TableCell>
        </Tr>
      ) : null}
      <Tr
        data-row={row.id}
        data-state={selected ? 'selected' : undefined}
        data-pending={row.pending ? 'yes' : undefined}
        aria-selected={selected}
        className={cn('cursor-default', opened && 'bg-accent', gone && 'opacity-50', row.pending && 'opacity-70')}
        onClick={() => onPick(row.id)}
      >
        <TableCell className="font-mono text-xs text-muted-foreground tabular-nums">{row.pending ? 'sending…' : '#' + row.id}</TableCell>
        <TableCell className="truncate">{row.title}</TableCell>
        <TableCell>
          <span className="inline-flex items-center gap-1.5">
            <StateMark row={row} />
            {row.word === row.shown ? <span className="font-mono text-mono-ui text-muted-foreground">{row.word}</span> : null}
            {kindsOf(row).map((kind) => (
              <Kind key={kind} kind={kind} />
            ))}
          </span>
        </TableCell>
        <TableCell className={cn('truncate font-mono text-xs', WIDTH.assignee)}>{row.assigneeName ? '@' + row.assigneeName : <span className="text-muted-foreground">—</span>}</TableCell>
        <TableCell className={cn('truncate font-mono text-xs text-muted-foreground', WIDTH.owner)}>@{row.ownerName}</TableCell>
        <TableCell className={cn('truncate font-mono text-xs text-muted-foreground', WIDTH.channel)}>{row.channel}</TableCell>
        <TableCell className={cn('truncate', WIDTH.labels)}>
          <span className="inline-flex gap-1">
            {labelPairs(row).map(([name, value]) => (
              <Label key={name} name={name} value={value} />
            ))}
          </span>
        </TableCell>
        <TableCell className="font-mono text-xs text-muted-foreground tabular-nums" title="The cursor of its last change">
          {row.pending ? '' : '#' + row.updated}
        </TableCell>
      </Tr>
    </>
  )
}

/** The board by state: a column per state, as the prototype lays them out, of the system's BoardCards. */
function Board({ items, selected, openId, gone, onPick }: { items: Item[]; selected: string | null; openId: string | null; gone: Set<string>; onPick: (id: string) => void }) {
  // The work's pipeline always; Done and Failed when they hold something (not under the Open filter).
  const groups = SHOWN.filter((state) => (state !== 'done' && state !== 'failed') || items.some((item) => item.group === state))
  return (
    <div className="flex h-full gap-3 p-3" data-testid="task-board">
      {groups.map((state) => (
        <section key={state} data-group={state} aria-label={SHOWN_LABEL[state]} className="flex w-[302px] shrink-0 flex-col rounded-md bg-sidebar">
          <header className="flex items-center gap-2 px-3 py-2 font-mono text-mono-label text-muted-foreground">
            <TaskGlyph state={state} />
            {SHOWN_LABEL[state]}
            <span className="ml-auto">{items.filter((item) => item.group === state).length}</span>
          </header>
          <ul className="flex min-h-0 flex-col gap-2 overflow-y-auto px-2 pb-2">
            {items
              .filter((item) => item.group === state)
              .map(({ row }) => (
                <li key={row.id}>
                  <Card row={row} selected={selected === row.id} opened={openId === row.id} gone={gone.has(row.id)} onPick={onPick} />
                </li>
              ))}
          </ul>
        </section>
      ))}
    </div>
  )
}

function Card({ row, selected, opened, gone, onPick }: { row: TaskRow; selected: boolean; opened: boolean; gone: boolean; onPick: (id: string) => void }) {
  const avatar = useAssignee(row)
  return (
    <BoardCard
      data-row={row.id}
      aria-selected={selected}
      role="button"
      tabIndex={0}
      onClick={() => onPick(row.id)}
      cursor={row.pending ? 'sending…' : '#' + row.id}
      channel={row.channel}
      state={row.shown}
      title={row.title}
      kinds={kindsOf(row)}
      labels={labelPairs(row)}
      {...(avatar ? { assignee: avatar } : {})}
      className={cn('cursor-pointer', selected && 'outline-2 outline-ring', opened && 'bg-raised', gone && 'opacity-50')}
    />
  )
}

type T = ReturnType<typeof useTable<typeof features, TaskRow>>

/** Filters by owner, assignee, channel, and label (each a menu of the values there are, with counts), and the grouping. State is the list pane's chips. */
function Toolbar({ table, view, onView, rows, count }: { table: T; view: ListView; onView: (view: ListView) => void; rows: TaskRow[]; count: number }) {
  const name = useMemo(() => new Map(rows.flatMap((row) => [[row.owner, row.ownerName], [row.assignee, row.assigneeName]] as const)), [rows])
  const facet = (key: (typeof MENUS)[number]) => {
    const counts = new Map<string, number>()
    if (key === 'label') for (const row of rows) for (const label of row.labels) counts.set(label, (counts.get(label) ?? 0) + 1)
    else for (const [value, n] of table.getColumn(COLUMN_OF[key])!.getFacetedUniqueValues()) counts.set(String(value), n as number)
    for (const value of view[key]) if (!counts.has(value)) counts.set(value, 0)
    return [...counts.keys()].sort().map((value) => ({ value, n: counts.get(value)!, text: key === 'owner' || key === 'assignee' ? (value ? '@' + (name.get(value) ?? value) : 'No one') : value }))
  }
  const toggle = (key: (typeof MENUS)[number], value: string) => onView({ ...view, [key]: view[key].includes(value) ? view[key].filter((one) => one !== value) : [...view[key], value] })
  const TITLE = { owner: 'Owner', assignee: 'Assignee', channel: 'Channel', label: 'Label' } as const
  return (
    <div className="flex flex-wrap items-center gap-1.5 border-b px-4 py-2" role="toolbar" aria-label="Filters">
      {MENUS.map((key) => (
        <DropdownMenu key={key}>
          <DropdownMenuTrigger asChild>
            <Button variant={view[key].length ? 'secondary' : 'ghost'} size="xs" aria-label={'Filter by ' + TITLE[key].toLowerCase()}>
              {TITLE[key]}
              {view[key].length ? <span className="font-mono text-muted-foreground">{view[key].length === 1 ? (facet(key).find((one) => one.value === view[key][0])?.text ?? view[key][0]) : view[key].length}</span> : null}
              <ChevronDownIcon />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start" className="min-w-48">
            <DropdownMenuLabel className="text-xs text-muted-foreground">{TITLE[key]}</DropdownMenuLabel>
            {facet(key).map((option) => (
              <DropdownMenuCheckboxItem key={option.value} checked={view[key].includes(option.value)} onSelect={(event) => event.preventDefault()} onCheckedChange={() => toggle(key, option.value)}>
                <span className="flex-1 truncate font-mono text-xs">{option.text}</span>
                <span className="font-mono text-xs text-muted-foreground tabular-nums">{option.n}</span>
              </DropdownMenuCheckboxItem>
            ))}
            {view[key].length ? (
              <>
                <DropdownMenuSeparator />
                <DropdownMenuItem onSelect={() => onView({ ...view, [key]: [] })}>Clear</DropdownMenuItem>
              </>
            ) : null}
          </DropdownMenuContent>
        </DropdownMenu>
      ))}
      <span className="ml-auto font-mono text-xs text-muted-foreground tabular-nums" data-testid="task-count">
        {count} {count === 1 ? 'task' : 'tasks'}
      </span>
      <Button variant={view.group ? 'secondary' : 'ghost'} size="xs" aria-pressed={view.group} onClick={() => onView({ ...view, group: !view.group })} disabled={view.layout === 'board'}>
        Group by state
      </Button>
    </div>
  )
}

/** The list pane's state chips: Open (the default), each shown state, and All. */
const CHIP_STATES: { label: string; states: TaskState[] }[] = [
  { label: 'Open', states: ['waiting', 'ready', 'claimed', 'blocked'] },
  { label: 'Ready', states: ['waiting', 'ready'] },
  { label: 'Claimed', states: ['claimed'] },
  { label: 'Held', states: ['blocked'] },
  { label: 'Done', states: ['completed', 'canceled'] },
  { label: 'All', states: [] },
]
const same = (a: string[], b: string[]) => a.length === b.length && a.every((one) => b.includes(one))

export function stateChips(rows: TaskRow[], view: ListView, onView: (view: ListView) => void): Chip[] {
  return CHIP_STATES.map((chip) => ({
    label: chip.label,
    count: chip.states.length ? rows.filter((row) => chip.states.includes(row.state)).length : rows.length,
    active: same(view.state, chip.states),
    onClick: () => onView({ ...view, state: chip.states }),
  }))
}

/** The list pane's actions: the board or the list, and a new task. */
export function ListActions({ view, onView, channel }: { view: ListView; onView: (view: ListView) => void; channel?: string }) {
  return (
    <div className="flex items-center gap-1.5">
      <Button variant="ghost" size="xs" aria-pressed={view.layout === 'board'} onClick={() => onView({ ...view, layout: view.layout === 'board' ? 'list' : 'board' })}>
        {view.layout === 'board' ? <ListIcon /> : <LayoutGridIcon />}
        {view.layout === 'board' ? 'List view' : 'Board view'}
      </Button>
      <NewTask channel={channel} />
    </div>
  )
}

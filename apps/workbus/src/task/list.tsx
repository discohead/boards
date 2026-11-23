// A task list (design/workbus.md §9.3, Linear's): TanStack Table v9 sorts and filters the rows, and
// the list groups them by state, or lays them out as a board by state. j and k move the selection,
// Enter opens it in the thread pane (?thread=<id>). Rows update live, and the selected row never
// moves under the cursor: it holds its place (hold.ts), and the list scrolls to keep it where it was.
import { useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react'
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
import { ChevronDownIcon, ArrowDownIcon, ArrowUpIcon } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { DropdownMenu, DropdownMenuCheckboxItem, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuTrigger } from '@/components/ui/dropdown-menu'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow as Tr } from '@/components/ui/table'
import { cn } from '@/lib/utils'
import { useOpenThread } from '@/shell/open-thread'
import { holdSelected } from './hold.ts'
import { assigneeOf, holdLabel, holdOf, OPEN, shownLabels, STATE_LABEL, STATES, stateOf, type Task, type TaskState } from './model.ts'
import { ago } from './time.ts'
import { useActorNames } from './actors.ts'
import { StateIcon } from './state-icon.tsx'

/** A row as the table reads it: plain values per column, so sorting and filtering compare them. */
export type TaskRow = {
  id: string
  title: string
  state: TaskState
  assignee: string
  assigneeName: string
  owner: string
  ownerName: string
  channel: string
  labels: string[]
  /** The board's cursor at its last change: newer is more recent. */
  updated: number
  updatedAt: string
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

const rank = (state: TaskState) => STATES.indexOf(state)
const isOpenSet = (states: string[]) => states.length === OPEN.length && OPEN.every((state) => states.includes(state))
const helper = createColumnHelper<typeof features, TaskRow>()
const columns = helper.columns([
  helper.accessor('id', { header: '#', sortFn: (a, b) => Number(a.original.id) - Number(b.original.id) }),
  helper.accessor('title', { header: 'Title', sortFn: 'alphanumeric' }),
  helper.accessor('state', { header: 'State', filterFn: anyOf, sortFn: (a, b) => rank(a.original.state) - rank(b.original.state) }),
  helper.accessor('assignee', { header: 'Assignee', filterFn: anyOf, sortFn: (a, b) => a.original.assigneeName.localeCompare(b.original.assigneeName) }),
  helper.accessor('owner', { header: 'Owner', filterFn: anyOf, sortFn: (a, b) => a.original.ownerName.localeCompare(b.original.ownerName) }),
  helper.accessor('channel', { header: 'Channel', filterFn: anyOf, sortFn: 'alphanumeric' }),
  helper.accessor('labels', { header: 'Labels', filterFn: anyOf, enableSorting: false }),
  helper.accessor('updated', { header: 'Updated', sortFn: 'basic', sortDescFirst: true }),
])

const FILTERED = ['state', 'owner', 'assignee', 'channel', 'label'] as const
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
          title: (task.text.split('\n')[0] ?? '').replace(/^#+\s*/, '') || '(no text)',
          state: stateOf(task),
          assignee,
          assigneeName: assignee ? name(assignee) : '',
          owner: task.task.owner ?? '',
          ownerName: name(task.task.owner),
          channel: task.channel,
          labels: shownLabels(task.labels).map(([key, value]) => key + '=' + value),
          updated: task.version || Number.MAX_SAFE_INTEGER,
          updatedAt: (task.updatedAt as string | undefined) ?? task.editedAt ?? task.createdAt,
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
  const next: Item[] = (grouped ? [...sorted].sort((a, b) => rank(a.state) - rank(b.state)) : sorted).map((row) => ({ key: row.id, group: grouped ? row.state : '', row }))
  const kept = selected ? byId.get(selected) : undefined
  const items = holdSelected(shown.current, next, selected, kept ? { key: kept.id, group: kept.state, row: kept } : undefined)
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

  const order = items.map((item) => item.key)
  const move = (by: number) => {
    if (order.length === 0) return
    const at = selected ? order.indexOf(selected) : -1
    const to = at < 0 ? (by > 0 ? 0 : order.length - 1) : Math.max(0, Math.min(order.length - 1, at + by))
    moved.current = true
    setSelected(order[to]!)
  }
  useHotkey('J', () => move(1))
  useHotkey('K', () => move(-1))
  useHotkey('ArrowDown', () => move(1))
  useHotkey('ArrowUp', () => move(-1))
  useHotkey('Enter', () => selected && open(selected), { enabled: selected !== null })

  const pick = (id: string) => {
    setSelected(id)
    open(id)
  }
  const filtering = FILTERED.some((key) => view[key].length > 0)

  return (
    <div className="flex h-full min-h-0 flex-col">
      <Toolbar table={table} view={view} onView={onView} rows={rows} count={next.length} />
      <div ref={scroller} data-testid="task-list" aria-label={label} className="min-h-0 flex-1 overflow-auto [overflow-anchor:none]">
        {items.length === 0 ? (
          <div className="p-8 text-sm text-muted-foreground">{filtering ? 'No tasks match these filters.' : (empty ?? 'No tasks.')}</div>
        ) : view.layout === 'board' ? (
          <Board items={items} selected={selected} openId={thread} gone={gone} onPick={pick} />
        ) : (
          <Table className="min-w-3xl table-fixed">
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

const WIDTH: Record<string, string> = { id: 'w-14', title: 'w-auto', state: 'w-32', assignee: 'w-32', owner: 'w-28', channel: 'w-28', labels: 'w-40', updated: 'w-20' }

function Line({ item, header, count, selected, opened, gone, onPick }: { item: Item; header: string | null; count: number; selected: boolean; opened: boolean; gone: boolean; onPick: (id: string) => void }) {
  const row = item.row
  return (
    <>
      {header !== null ? (
        <Tr data-group={header} className="bg-muted/40 hover:bg-muted/40">
          <TableCell colSpan={8} className="py-1.5 text-xs font-medium">
            <span className="inline-flex items-center gap-2">
              <StateIcon state={header as TaskState} />
              {STATE_LABEL[header as TaskState]}
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
        <TableCell className="text-xs text-muted-foreground tabular-nums">{row.pending ? '' : row.id}</TableCell>
        <TableCell className="truncate">{row.title}</TableCell>
        <TableCell>
          <span className="inline-flex items-center gap-1.5 text-xs">
            <StateIcon state={row.state} />
            {row.hold ? holdLabel(row.hold) : STATE_LABEL[row.state]}
          </span>
        </TableCell>
        <TableCell className="truncate text-xs">{row.assigneeName ? '@' + row.assigneeName : <span className="text-muted-foreground">—</span>}</TableCell>
        <TableCell className="truncate text-xs text-muted-foreground">@{row.ownerName}</TableCell>
        <TableCell className="truncate text-xs text-muted-foreground">#{row.channel}</TableCell>
        <TableCell className="truncate">
          <span className="inline-flex gap-1">
            {row.labels.map((label) => (
              <Badge key={label} variant="outline" className="font-normal">
                {label}
              </Badge>
            ))}
          </span>
        </TableCell>
        <TableCell className="font-mono text-xs text-muted-foreground tabular-nums" suppressHydrationWarning>
          {ago(row.updatedAt)}
        </TableCell>
      </Tr>
    </>
  )
}

/** The board by state: a column per state that has tasks, the same rows and selection as the list. */
function Board({ items, selected, openId, gone, onPick }: { items: Item[]; selected: string | null; openId: string | null; gone: Set<string>; onPick: (id: string) => void }) {
  const groups = STATES.filter((state) => items.some((item) => item.group === state))
  return (
    <div className="flex h-full gap-3 p-3" data-testid="task-board">
      {groups.map((state) => (
        <section key={state} data-group={state} aria-label={STATE_LABEL[state]} className="flex w-72 shrink-0 flex-col rounded-lg bg-muted/40">
          <header className="flex items-center gap-2 px-3 py-2 text-xs font-medium">
            <StateIcon state={state} />
            {STATE_LABEL[state]}
            <span className="text-muted-foreground">{items.filter((item) => item.group === state).length}</span>
          </header>
          <ul className="flex min-h-0 flex-col gap-2 overflow-y-auto px-2 pb-2">
            {items
              .filter((item) => item.group === state)
              .map(({ row }) => (
                <li key={row.id}>
                  <button
                    data-row={row.id}
                    aria-selected={selected === row.id}
                    onClick={() => onPick(row.id)}
                    className={cn('w-full rounded-md border bg-background p-2 text-left text-sm shadow-xs', selected === row.id && 'ring-2 ring-ring', openId === row.id && 'bg-accent', gone.has(row.id) && 'opacity-50')}
                  >
                    <div className="text-xs text-muted-foreground">
                      #{row.id} · #{row.channel}
                    </div>
                    <div className="mt-0.5 line-clamp-2">{row.title}</div>
                    <div className="mt-1 flex flex-wrap items-center gap-1 text-xs text-muted-foreground">
                      {row.hold ? <Badge variant="secondary">{holdLabel(row.hold)}</Badge> : null}
                      {row.assigneeName ? <span>@{row.assigneeName}</span> : null}
                      {row.labels.map((label) => (
                        <Badge key={label} variant="outline" className="font-normal">
                          {label}
                        </Badge>
                      ))}
                    </div>
                  </button>
                </li>
              ))}
          </ul>
        </section>
      ))}
    </div>
  )
}

type T = ReturnType<typeof useTable<typeof features, TaskRow>>

/** Filters by state, owner, assignee, channel, and label (each a menu of the values there are, with counts), the grouping, and the layout. */
function Toolbar({ table, view, onView, rows, count }: { table: T; view: ListView; onView: (view: ListView) => void; rows: TaskRow[]; count: number }) {
  const name = useMemo(() => new Map(rows.flatMap((row) => [[row.owner, row.ownerName], [row.assignee, row.assigneeName]] as const)), [rows])
  const facet = (key: (typeof FILTERED)[number]) => {
    const counts = new Map<string, number>()
    if (key === 'label') for (const row of rows) for (const label of row.labels) counts.set(label, (counts.get(label) ?? 0) + 1)
    else for (const [value, n] of table.getColumn(COLUMN_OF[key])!.getFacetedUniqueValues()) counts.set(String(value), n as number)
    for (const value of view[key]) if (!counts.has(value)) counts.set(value, 0)
    const values = [...counts.keys()]
    if (key === 'state') values.sort((a, b) => rank(a as TaskState) - rank(b as TaskState))
    else values.sort()
    return values.map((value) => ({ value, n: counts.get(value)!, text: key === 'state' ? STATE_LABEL[value as TaskState] : key === 'owner' || key === 'assignee' ? (value ? '@' + (name.get(value) ?? value) : 'No one') : key === 'channel' ? '#' + value : value }))
  }
  const toggle = (key: (typeof FILTERED)[number], value: string) => onView({ ...view, [key]: view[key].includes(value) ? view[key].filter((one) => one !== value) : [...view[key], value] })
  const TITLE = { state: 'State', owner: 'Owner', assignee: 'Assignee', channel: 'Channel', label: 'Label' } as const
  return (
    <div className="flex flex-wrap items-center gap-1.5 border-b px-4 py-2" role="toolbar" aria-label="Filters">
      {FILTERED.map((key) => (
        <DropdownMenu key={key}>
          <DropdownMenuTrigger asChild>
            <Button variant={view[key].length ? 'secondary' : 'ghost'} size="xs" aria-label={'Filter by ' + TITLE[key].toLowerCase()}>
              {TITLE[key]}
              {view[key].length ? <span className="text-muted-foreground">: {key === 'state' && isOpenSet(view.state) ? 'open' : view[key].length === 1 ? facet(key).find((one) => one.value === view[key][0])?.text ?? view[key][0] : view[key].length}</span> : null}
              <ChevronDownIcon />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start" className="min-w-48">
            <DropdownMenuLabel className="text-xs text-muted-foreground">{TITLE[key]}</DropdownMenuLabel>
            {facet(key).map((option) => (
              <DropdownMenuCheckboxItem key={option.value} checked={view[key].includes(option.value)} onSelect={(event) => event.preventDefault()} onCheckedChange={() => toggle(key, option.value)}>
                <span className="flex-1 truncate">{option.text}</span>
                <span className="text-xs text-muted-foreground tabular-nums">{option.n}</span>
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
      <span className="ml-auto text-xs text-muted-foreground tabular-nums" data-testid="task-count">
        {count} {count === 1 ? 'task' : 'tasks'}
      </span>
      <Button variant={view.group ? 'secondary' : 'ghost'} size="xs" aria-pressed={view.group} onClick={() => onView({ ...view, group: !view.group })} disabled={view.layout === 'board'}>
        Group by state
      </Button>
      <Button variant="ghost" size="xs" aria-pressed={view.layout === 'board'} onClick={() => onView({ ...view, layout: view.layout === 'board' ? 'list' : 'board' })}>
        {view.layout === 'board' ? 'List' : 'Board'}
      </Button>
    </div>
  )
}

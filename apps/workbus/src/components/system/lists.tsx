// IssueRow and BoardCard: a task in a list, and on a board grouped by state.
import type { ComponentProps } from 'react'
import { cn } from '@/lib/utils'
import { Avatar, type AvatarProps } from './avatar'
import { Kind, Label, TaskState, type KindName, type TaskStateName } from './status'

export interface IssueRowProps {
  cursor: string
  state: TaskStateName
  title: string
  kinds?: KindName[]
  labels?: [string, string][]
  assignee?: AvatarProps
  updated: string
  selected?: boolean
}

/** cursor, state, title, kinds and labels, assignee, updated. Height follows density. */
export function IssueRow({ cursor, state, title, kinds, labels, assignee, updated, selected, className, ...props }: IssueRowProps & Omit<ComponentProps<'div'>, 'title'>) {
  return (
    <div
      role="row"
      tabIndex={0}
      aria-selected={selected || undefined}
      data-slot="issue-row"
      className={cn(
        'grid min-h-row cursor-pointer grid-cols-[56px_16px_minmax(0,1fr)_auto_18px_64px] items-center gap-2.5 border-b border-line px-3 py-1 text-ui transition-fast last:border-b-0 hover:bg-raised',
        selected && 'bg-selected hover:bg-selected',
        className,
      )}
      {...props}
    >
      <span className="font-mono text-mono-ui text-muted-foreground tabular-nums">{cursor}</span>
      <TaskState state={state} />
      <span className="truncate text-text">{title}</span>
      <span className="flex gap-1">
        {kinds?.map((k) => <Kind key={k} kind={k} />)}
        {labels?.map(([n, v]) => <Label key={n} name={n} value={v} />)}
      </span>
      {assignee ? <Avatar size="xs" {...assignee} /> : <span />}
      <span className="text-right font-mono text-mono-ui text-muted-foreground tabular-nums">{updated}</span>
    </div>
  )
}

export interface BoardCardProps {
  cursor: string
  channel?: string
  state: TaskStateName
  title: string
  kinds?: KindName[]
  labels?: [string, string][]
  assignee?: AvatarProps
  cost?: string
}

/** Flat: a hairline and no shadow. A held card takes a held border. */
export function BoardCard({ cursor, channel, state, title, kinds, labels, assignee, cost, className, ...props }: BoardCardProps & Omit<ComponentProps<'div'>, 'title'>) {
  return (
    <div
      data-slot="board-card"
      className={cn('flex w-[286px] max-w-full flex-col gap-2 rounded-md border border-line bg-surface px-3 py-2.5 text-[13px]', state === 'held' && 'border-held', className)}
      {...props}
    >
      <div className="flex items-center gap-2">
        <span className="font-mono text-mono-ui text-muted-foreground tabular-nums">{cursor + (channel ? ' · ' + channel : '')}</span>
        <TaskState state={state} className="ml-auto" />
      </div>
      <div className="leading-[1.35] font-[550] text-text">{title}</div>
      <div className="flex items-center gap-1.5">
        {kinds?.map((k) => <Kind key={k} kind={k} />)}
        {labels?.map(([n, v]) => <Label key={n} name={n} value={v} />)}
        {assignee ? <Avatar size="xs" {...assignee} /> : null}
        {cost ? <span className="ml-auto font-mono text-mono-ui text-muted-foreground tabular-nums">{cost}</span> : null}
      </div>
    </div>
  )
}

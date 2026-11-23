// The list pane every view puts on the left of the workspace: its title, filter chips (All, Held,
// Unread, …), date bars, the rows, and the J/K and ↵ foot. Its owners fill it; the frame sizes it.
import type { ReactNode } from 'react'
import { cn } from '@/lib/utils'
import { Kbd } from '@/components/system'

export type Chip = { label: string; count?: number; active?: boolean; onClick?: () => void }

export function ListPane({ title, label, actions, chips, children, foot = true }: { title: string; label?: string; actions?: ReactNode; chips?: Chip[]; children: ReactNode; foot?: boolean }) {
  return (
    <section aria-label={label ?? title} data-testid="list-pane" className="flex min-h-0 flex-col">
      <div className="flex items-center justify-between px-4 pt-5 pb-2">
        <h1 className="text-title-xl text-text">{title}</h1>
        {actions}
      </div>
      {chips?.length ? (
        <div role="group" aria-label="Filter" className="flex gap-1 px-4 pb-3">
          {chips.map((chip) => (
            <button key={chip.label} type="button" aria-pressed={chip.active ?? false} onClick={chip.onClick} className={cn('rounded-sm px-2 py-0.5 text-sm', chip.active ? 'bg-accent text-foreground' : 'text-muted-foreground hover:bg-accent')}>
              {chip.label}
              {chip.count !== undefined ? <span className="ml-1 font-mono text-xs">{chip.count}</span> : null}
            </button>
          ))}
        </div>
      ) : null}
      <div className="min-h-0 flex-1 overflow-y-auto border-t">{children}</div>
      {foot ? (
        <footer className="flex items-center gap-1 border-t px-4 py-2 font-mono text-xs text-muted-foreground">
          <Kbd>J</Kbd>
          <Kbd>K</Kbd> navigate <Kbd className="ml-2">↵</Kbd> open
        </footer>
      ) : null}
    </section>
  )
}

/** A bar between days in a list: the day and how many rows it holds. */
export function DateBar({ day, count }: { day: string; count?: number }) {
  return (
    <div className="flex justify-between border-b bg-sidebar px-4 py-1 font-mono text-xs text-muted-foreground">
      <span>{day}</span>
      {count !== undefined ? <span>{count}</span> : null}
    </div>
  )
}

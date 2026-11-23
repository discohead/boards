// A task's state as a glyph: a ring, filled as the work goes on. Stands in for the design system's
// TaskState until it lands in the app.
import type { ShownState } from '@/data'
import { cn } from '@/lib/utils'

const COLOR: Record<ShownState, string> = {
  ready: 'text-muted-foreground',
  claimed: 'text-foreground',
  held: 'text-primary',
  done: 'text-muted-foreground',
  failed: 'text-destructive',
}

export function StateIcon({ state, className }: { state: ShownState; className?: string }) {
  return (
    <svg viewBox="0 0 14 14" aria-hidden className={cn('size-3.5 shrink-0', COLOR[state] ?? 'text-muted-foreground', className)}>
      <circle cx="7" cy="7" r="5.5" fill="none" stroke="currentColor" strokeWidth="1.5" />
      {state === 'claimed' ? <path d="M7 3.5 A3.5 3.5 0 0 1 7 10.5 Z" fill="currentColor" /> : null}
      {state === 'done' ? <path d="M4.4 7.2 6.2 9 9.6 5.2" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" /> : null}
      {state === 'held' ? <path d="M5 5.2v3.6M9 5.2v3.6" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" /> : null}
      {state === 'failed' ? <path d="M5 5 9 9M9 5 5 9" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" /> : null}
    </svg>
  )
}

// A task's state as Linear draws it: a small circle, filled as the work goes on.
import { cn } from '@/lib/utils'
import type { TaskState } from './model.ts'

const COLOR: Record<TaskState, string> = {
  blocked: 'text-amber-600',
  claimed: 'text-primary',
  ready: 'text-muted-foreground',
  waiting: 'text-muted-foreground/60',
  failed: 'text-destructive',
  completed: 'text-emerald-600',
  canceled: 'text-muted-foreground/60',
}

export function StateIcon({ state, className }: { state: TaskState; className?: string }) {
  const color = COLOR[state] ?? 'text-muted-foreground'
  return (
    <svg viewBox="0 0 14 14" aria-hidden className={cn('size-3.5 shrink-0', color, className)}>
      <circle cx="7" cy="7" r="5.5" fill="none" stroke="currentColor" strokeWidth="1.5" strokeDasharray={state === 'waiting' ? '2 1.6' : undefined} />
      {state === 'claimed' ? <path d="M7 3.5 A3.5 3.5 0 0 1 7 10.5 Z" fill="currentColor" /> : null}
      {state === 'completed' ? <path d="M4.4 7.2 6.2 9 9.6 5.2" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" /> : null}
      {state === 'blocked' ? <path d="M5 5.2v3.6M9 5.2v3.6" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" /> : null}
      {state === 'failed' || state === 'canceled' ? <path d="M5 5 9 9M9 5 5 9" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" /> : null}
    </svg>
  )
}

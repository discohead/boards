// The status marks: SeatState, Kind, Label, HeldPill, TaskState. Every one carries a shape or a
// word as well as a color.
import type { ReactNode } from 'react'
import { AtSign, CircleCheck, CircleX, GitBranch, ShieldCheck, Split, SquareCheck, Wallet, type LucideIcon } from 'lucide-react'
import { cn } from '@/lib/utils'

export type SeatStateName = 'active' | 'working' | 'waiting' | 'paused' | 'over_budget'
export type KindName = 'approval' | 'decision' | 'budget' | 'review' | 'proposal' | 'mention' | 'done' | 'failed'
export type TaskStateName = 'ready' | 'claimed' | 'held' | 'done' | 'failed'

export interface SeatStateProps {
  state: SeatStateName
  label?: string
  className?: string
}

const SEAT_WORD: Record<SeatStateName, string> = { active: 'active', working: 'working', waiting: 'waiting', paused: 'paused', over_budget: 'over budget' }
const SEAT_TONE: Record<SeatStateName, string> = {
  active: 'text-muted-foreground',
  working: 'text-agent',
  waiting: 'text-held',
  paused: 'text-muted-foreground',
  over_budget: 'text-danger',
}
const SEAT_MARK: Record<SeatStateName, string> = {
  active: 'size-[7px] rounded-full bg-current opacity-40',
  working: 'size-[7px] rounded-full bg-current',
  waiting: 'size-[7px] rounded-full bg-current',
  paused: 'size-[10px] rounded-full border-[1.5px] border-current',
  over_budget: 'size-[6px] rotate-45 rounded-[1px] bg-current',
}

/** A seat's live state: a mark (dot, ring, or diamond) and its word in mono. */
export function SeatState({ state, label, className }: SeatStateProps) {
  return (
    <span data-slot="seat-state" data-state={state} className={cn('inline-flex items-center gap-1.5 font-mono text-mono-ui whitespace-nowrap', SEAT_TONE[state], className)}>
      <i aria-hidden className={cn('flex-none', SEAT_MARK[state])} />
      {label ?? SEAT_WORD[state]}
    </span>
  )
}

export interface KindProps {
  kind: KindName
  children?: ReactNode
  /** Its icon and capitalized word in the kind's ink, no tint: the inbox row's form (the prototype). */
  plain?: boolean
  className?: string
}

const KIND_ICON: Record<KindName, LucideIcon> = {
  approval: ShieldCheck,
  decision: Split,
  budget: Wallet,
  review: SquareCheck,
  proposal: GitBranch,
  mention: AtSign,
  done: CircleCheck,
  failed: CircleX,
}

const KIND_TONE: Record<KindName, string> = {
  approval: 'bg-held-soft text-held',
  decision: 'bg-held-soft text-held',
  budget: 'bg-raised text-warning',
  review: 'bg-raised text-info',
  proposal: 'bg-raised text-info',
  mention: 'bg-raised text-muted-foreground',
  done: 'bg-raised text-success',
  failed: 'bg-raised text-danger',
}

/** The kind of an inbox item or held task, in mono on a tint. Held kinds are vermilion. */
export function Kind({ kind, children, plain, className }: KindProps) {
  if (plain) {
    const Glyph = KIND_ICON[kind]
    return (
      <span data-slot="kind" data-kind={kind} className={cn('inline-flex items-center gap-1 font-mono text-mono-label capitalize', KIND_TONE[kind].replace(/bg-\S+ /, ''), className)}>
        <Glyph size={13} strokeWidth={1.5} aria-hidden />
        {children ?? kind}
      </span>
    )
  }
  return (
    <span data-slot="kind" data-kind={kind} className={cn('rounded-xs px-1.5 font-mono text-[10.5px] leading-[18px] whitespace-nowrap', KIND_TONE[kind], className)}>
      {children ?? kind}
    </span>
  )
}

export interface LabelProps {
  name: string
  value?: string
  className?: string
}

/** A typed label from the board, as written (project=launch). Never colored. */
export function Label({ name, value, className }: LabelProps) {
  return (
    <span data-slot="label" className={cn('rounded-xs border border-line px-[5px] font-mono text-[10.5px] leading-[17px] whitespace-nowrap text-muted-foreground', className)}>
      {name}
      {value != null ? (
        <>
          =<b className="font-medium text-text">{value}</b>
        </>
      ) : null}
    </span>
  )
}

export interface HeldPillProps {
  kind?: 'approval' | 'decision' | 'review' | 'budget'
  /** Words in place of "Held · <kind>", e.g. "Held for you" (the prototype's facts row). */
  children?: ReactNode
  className?: string
}

/** The strongest status mark: a thread or task held for you. One per view. */
export function HeldPill({ kind = 'approval', children, className }: HeldPillProps) {
  return (
    <span data-slot="held-pill" className={cn('inline-flex items-center gap-1.5 rounded-sm bg-held-soft px-2 py-0.5 text-[11.5px] font-semibold whitespace-nowrap text-held', className)}>
      <i aria-hidden className="size-1.5 rounded-full bg-current" />
      {children ?? <>Held · {kind}</>}
    </span>
  )
}

export interface TaskStateProps {
  state: TaskStateName
  /** A word beside the glyph, in mono: "waits on #12", "canceled". It also names the glyph. */
  label?: string
  /** Muted ink, for a state that closed without its outcome (a canceled task shows as done, muted). */
  muted?: boolean
  className?: string
}

const TASK_TITLE: Record<TaskStateName, string> = { ready: 'Ready', claimed: 'Claimed', held: 'Held for you', done: 'Done', failed: 'Failed' }

/**
 * The task glyph, 14px: ready (a ring), claimed (a half-filled agent ring), held (a vermilion ring
 * with pause bars), done (a filled success circle, a check), failed (a filled danger circle, an x).
 * The framework's states map onto these five in the data layer (blocked is held, completed is done).
 */
export function TaskState({ state, label, muted, className }: TaskStateProps) {
  const title = label ?? TASK_TITLE[state]
  const ink = muted ? 'var(--wb-muted)' : undefined
  let glyph: ReactNode
  if (state === 'ready') glyph = <circle cx={8} cy={8} r={5.5} fill="none" stroke="var(--wb-muted)" strokeWidth={1.5} />
  else if (state === 'claimed')
    glyph = (
      <>
        <circle cx={8} cy={8} r={5.5} fill="none" stroke={ink ?? 'var(--wb-agent)'} strokeWidth={1.5} />
        <path d="M8 4.5a3.5 3.5 0 0 1 0 7z" fill={ink ?? 'var(--wb-agent)'} />
      </>
    )
  else if (state === 'held')
    glyph = (
      <>
        <circle cx={8} cy={8} r={5.5} fill="none" stroke={ink ?? 'var(--wb-held)'} strokeWidth={1.5} />
        <path d="M6.5 6v4M9.5 6v4" stroke={ink ?? 'var(--wb-held)'} strokeWidth={1.5} />
      </>
    )
  else if (state === 'done')
    glyph = (
      <>
        <circle cx={8} cy={8} r={6.25} fill={ink ?? 'var(--wb-success)'} />
        <path d="M5.5 8.2l1.7 1.7 3.3-3.4" fill="none" stroke="var(--wb-bg)" strokeWidth={1.5} />
      </>
    )
  else
    glyph = (
      <>
        <circle cx={8} cy={8} r={6.25} fill={ink ?? 'var(--wb-danger)'} />
        <path d="M6 6l4 4M10 6l-4 4" stroke="var(--wb-bg)" strokeWidth={1.5} />
      </>
    )
  const svg = (
    <svg data-slot="task-state" data-state={state} viewBox="0 0 16 16" role="img" aria-label={title} className={cn('inline-block size-3.5 flex-none align-middle', !label && className)}>
      <title>{title}</title>
      {glyph}
    </svg>
  )
  if (!label) return svg
  return (
    <span className={cn('inline-flex items-center gap-1.5 font-mono text-mono-ui whitespace-nowrap text-muted-foreground', className)}>
      {svg}
      <span aria-hidden>{label}</span>
    </span>
  )
}

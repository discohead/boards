// Message, ToolCall, and ApprovalCard: one event in a thread, a tool call inside it, and the
// answer to a held task.
import type { ComponentProps, ReactNode } from 'react'
import { ShieldCheck } from 'lucide-react'
import { cn } from '@/lib/utils'
import { Avatar } from './avatar'
import { Button } from './button'

export interface MessageProps {
  author: { name: string; handle?: string; initials: string; kind?: 'person' | 'agent' }
  time?: string
  cursor?: string
  /** Your own write before its event comes back. */
  pending?: boolean
  /** A new event from someone else: a brief agent tint. */
  arrive?: boolean
  children: ReactNode
}

/** Not a bubble: everyone's messages sit in one column on bg. */
export function Message({ author, time, cursor, pending, arrive, children, className, ...props }: MessageProps & Omit<ComponentProps<'div'>, 'children'>) {
  return (
    <div
      data-slot="message"
      data-pending={pending || undefined}
      className={cn('grid grid-cols-[var(--spacing-avatar-md)_minmax(0,1fr)] gap-2.5 px-5 py-(--wb-pad-y)', arrive && 'animate-arrive', className)}
      {...props}
    >
      <Avatar kind={author.kind} initials={author.initials} name={author.name} size="md" />
      <div className="min-w-0">
        <div className="flex items-baseline gap-2">
          <span className="font-semibold text-text">{author.name}</span>
          {author.handle ? <span className="font-mono text-mono-ui text-muted-foreground">{author.handle}</span> : null}
          <span className="ml-auto font-mono text-mono-ui text-muted-foreground tabular-nums">
            {pending ? 'sending…' : [time, cursor].filter(Boolean).join(' · ')}
          </span>
        </div>
        <div className={cn('mt-[3px] text-doc [overflow-wrap:anywhere] [&_code]:font-mono [&_code]:text-[0.9em] [&_code]:text-text', pending ? 'text-muted-foreground' : 'text-body')}>{children}</div>
      </div>
    </div>
  )
}

export interface ToolCallProps {
  name: string
  input: unknown
  status?: 'held' | 'running' | 'ok' | 'failed'
  statusLabel?: string
}

const TOOL_WORD = { held: 'waiting for approval', ok: 'done', failed: 'failed', running: 'running' }
const TOOL_TONE = { held: 'text-held', ok: 'text-success', failed: 'text-danger', running: '' }

/** A tool call inside its message: its name, status, and input as sent, in mono on raised. */
export function ToolCall({ name, input, status = 'held', statusLabel }: ToolCallProps) {
  return (
    <div data-slot="tool-call" className="mt-2 overflow-hidden rounded-sm border border-line bg-raised font-mono text-[11.5px]">
      <div className="flex justify-between gap-2 border-b border-line px-2.5 py-1.5 text-[10.5px] text-muted-foreground">
        <b className="font-semibold text-text">{name}</b>
        <span className={TOOL_TONE[status]}>{statusLabel ?? TOOL_WORD[status]}</span>
      </div>
      <pre className="m-0 px-2.5 py-2 whitespace-pre-wrap text-body">{typeof input === 'string' ? input : JSON.stringify(input)}</pre>
    </div>
  )
}

export interface ApprovalCardProps {
  /** A mono label above the title, with the held mark: "Deployment approval". */
  eyebrow?: string
  title: string
  reason?: string
  approveLabel?: string
  /** Run facts: "18 steps · 41s · $0.42". */
  run?: string
  onApprove?: () => void
  onDecline?: () => void
  onReply?: () => void
}

/**
 * The one place held fills a surface: a held-soft ground and a held edge, each mixed toward the
 * surface as the prototype draws them. Approve is the view's primary (⌘↵); Reply shows when it has
 * a handler.
 */
export function ApprovalCard({ eyebrow, title, reason, approveLabel = 'Approve', run, onApprove, onDecline, onReply }: ApprovalCardProps) {
  return (
    <div
      role="group"
      aria-label={title}
      data-slot="approval-card"
      className="rounded-md border border-[color-mix(in_srgb,var(--wb-held)_42%,var(--wb-line))] bg-[color-mix(in_srgb,var(--wb-held-soft)_53%,var(--wb-surface))] px-4 py-3.5"
    >
      {eyebrow ? (
        <div className="flex items-center gap-2 font-mono text-mono-label tracking-[0.07em] text-held uppercase">
          <ShieldCheck size={16} strokeWidth={1.5} aria-hidden />
          {eyebrow}
        </div>
      ) : null}
      <div className={cn('text-title-md text-text', eyebrow && 'mt-[9px]')}>{title}</div>
      {reason ? <p className="mt-[3px] text-[13px] leading-[1.55] text-body">{reason}</p> : null}
      <div className="mt-3 flex flex-wrap items-center gap-2">
        <Button variant="primary" icon="check" kbd="⌘↵" onClick={onApprove}>
          {approveLabel}
        </Button>
        <Button variant="outline" onClick={onDecline}>
          Decline
        </Button>
        {onReply ? (
          <Button variant="outline" onClick={onReply}>
            Reply
          </Button>
        ) : null}
        {run ? <span className="ml-auto font-mono text-mono-ui text-muted-foreground tabular-nums">{run}</span> : null}
      </div>
    </div>
  )
}

// Message, ToolCall, and ApprovalCard: one event in a thread, a tool call inside it, and the
// answer to a held task.
import type { ComponentProps, ReactNode } from 'react'
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
            {pending ? 'sending…' : (cursor ? cursor + ' · ' : '') + (time ?? '')}
          </span>
        </div>
        <div className={cn('mt-0.5 [&_code]:font-mono [&_code]:text-[0.9em] [&_code]:text-text', pending ? 'text-muted-foreground' : 'text-body')}>{children}</div>
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
  title: string
  reason?: string
  approveLabel?: string
  /** Run facts: "18 steps · 41s · $0.42". */
  run?: string
  onApprove?: () => void
  onDecline?: () => void
  onReply?: () => void
}

/** The one place held fills a surface. Approve is the view's primary (⌘↵). */
export function ApprovalCard({ title, reason, approveLabel = 'Approve', run, onApprove, onDecline, onReply }: ApprovalCardProps) {
  return (
    <div role="group" aria-label={title} data-slot="approval-card" className="flex flex-col gap-2.5 rounded-md border border-held bg-held-soft px-3.5 py-3">
      <div>
        <div className="font-semibold text-text">{title}</div>
        {reason ? <div className="mt-0.5 text-small text-muted-foreground">{reason}</div> : null}
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <Button variant="primary" kbd="⌘↵" onClick={onApprove}>
          {approveLabel}
        </Button>
        <Button variant="outline" onClick={onDecline}>
          Decline
        </Button>
        <Button variant="outline" onClick={onReply}>
          Reply
        </Button>
        {run ? <span className="ml-auto font-mono text-mono-ui text-muted-foreground tabular-nums">{run}</span> : null}
      </div>
    </div>
  )
}

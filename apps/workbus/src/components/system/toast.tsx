import type { ReactNode } from 'react'
import { toast as sonner } from 'sonner'
import { cn } from '@/lib/utils'
import { Button } from './button'
import { Icon } from './icon'

export interface ToastProps {
  children: ReactNode
  tone?: 'success' | 'danger'
  /** The log position the action produced, e.g. "#1288". */
  cursor?: string
  action?: { label: string; kbd?: string; onClick?: () => void }
  className?: string
}

/** What you just did, in the past tense, with its cursor and, where it can be undone, Undo. */
export function Toast({ children, tone = 'success', cursor, action, className }: ToastProps) {
  return (
    <div
      role={tone === 'danger' ? 'alert' : 'status'}
      className={cn('flex max-w-[440px] items-center gap-2.5 rounded-md border border-line bg-surface px-3 py-2.5 text-[13px] text-text shadow-float', className)}
    >
      <Icon name={tone === 'danger' ? 'x' : 'check'} strokeWidth={2} className={cn('flex-none', tone === 'danger' ? 'text-danger' : 'text-success')} />
      <span>
        {children}
        {cursor ? <span className="font-mono text-mono-ui text-muted-foreground"> {cursor}</span> : null}
      </span>
      {action ? (
        <Button variant="ghost" size="sm" kbd={action.kbd} onClick={action.onClick} className="ml-auto">
          {action.label}
        </Button>
      ) : null}
    </div>
  )
}

/**
 * Shows a Toast through the app's Toaster (bottom left; 5 s, paused on hover). Errors
 * (tone "danger") stay until dismissed. Returns the toast's id.
 */
export function toast(props: ToastProps) {
  return sonner.custom(
    (id) => (
      <Toast
        {...props}
        action={
          props.action && {
            ...props.action,
            onClick: () => {
              props.action?.onClick?.()
              sonner.dismiss(id)
            },
          }
        }
      />
    ),
    { duration: props.tone === 'danger' ? Infinity : 5000 },
  )
}

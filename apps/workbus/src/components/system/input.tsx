import type { ChangeEvent } from 'react'
import { cn } from '@/lib/utils'
import { Kbd } from './kbd'

export interface InputProps {
  id?: string
  label?: string
  /** Mono affix before the value: "$", "@". */
  prefix?: string
  placeholder?: string
  value?: string
  defaultValue?: string
  kbd?: string
  hint?: string
  /** Says what's wrong and how to fix it. */
  error?: string
  onChange?: (e: ChangeEvent<HTMLInputElement>) => void
  className?: string
}

/** A single-line field: line-control border, a focus border with a held-soft halo. */
export function Input({ id, label, prefix, kbd, hint, error, className, ...props }: InputProps) {
  const field = (
    <span
      className={cn(
        'flex h-control-md items-center gap-2 rounded-sm border border-line-control bg-surface px-2.5 text-[13px] text-text transition-fast',
        'focus-within:border-focus focus-within:shadow-[0_0_0_3px_var(--wb-held-soft)]',
        error && 'border-danger',
        !label && !hint && !error && className,
      )}
    >
      {prefix ? <span className="font-mono text-[12px] text-muted-foreground">{prefix}</span> : null}
      <input
        id={id}
        aria-invalid={error ? true : undefined}
        aria-describedby={error || hint ? id && id + '-help' : undefined}
        className="min-w-0 flex-1 bg-transparent text-text outline-none placeholder:text-muted-foreground focus-visible:outline-none"
        {...props}
      />
      {kbd ? <Kbd>{kbd}</Kbd> : null}
    </span>
  )
  if (!label && !hint && !error) return field
  return (
    <label htmlFor={id} className={cn('flex flex-col gap-1 text-small text-muted-foreground', className)}>
      {label ? <span className="font-medium text-text">{label}</span> : null}
      {field}
      {error ? (
        <span id={id && id + '-help'} className="text-danger">
          {error}
        </span>
      ) : hint ? (
        <span id={id && id + '-help'}>{hint}</span>
      ) : null}
    </label>
  )
}

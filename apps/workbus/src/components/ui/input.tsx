import * as React from 'react'
import { cn } from '@/lib/utils'

// shadcn/ui's Input, restyled: a line-control border (3:1) and, on focus, a focus border with a
// held-soft halo.
function Input({ className, type, ...props }: React.ComponentProps<'input'>) {
  return (
    <input
      type={type}
      data-slot="input"
      className={cn(
        'h-control-md w-full min-w-0 rounded-sm border border-line-control bg-surface px-2.5 text-[13px] text-text transition-fast outline-none placeholder:text-muted-foreground',
        'focus-visible:border-focus focus-visible:shadow-[0_0_0_3px_var(--wb-held-soft)] focus-visible:outline-none',
        'disabled:cursor-not-allowed disabled:opacity-45 aria-invalid:border-danger',
        className,
      )}
      {...props}
    />
  )
}

export { Input }

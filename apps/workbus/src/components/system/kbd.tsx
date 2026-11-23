import type { ComponentProps, ReactNode } from 'react'
import { cn } from '@/lib/utils'

export interface KbdProps {
  children: ReactNode
}

/** A keyboard shortcut in mono: ⌘ ⇧ ⌥ ↵ esc, and single capitals. */
export function Kbd({ children, className, ...props }: KbdProps & Omit<ComponentProps<'kbd'>, 'children'>) {
  return (
    <kbd
      data-slot="kbd"
      className={cn('rounded-xs border border-line-strong px-1 font-mono text-mono-label whitespace-nowrap text-muted-foreground', className)}
      {...props}
    >
      {children}
    </kbd>
  )
}

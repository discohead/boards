import type { ComponentProps, ReactNode } from 'react'
import { Slot } from 'radix-ui'
import { cn } from '@/lib/utils'
import { Avatar, type AvatarProps } from './avatar'
import { SeatState, type SeatStateName } from './status'

export interface SidebarItemProps {
  children: ReactNode
  active?: boolean
  unread?: boolean
  child?: boolean
  count?: number
  state?: SeatStateName
  meta?: string | number
  avatar?: AvatarProps
  /** Render as the child element (a router Link), keeping the row's look. */
  asChild?: boolean
  className?: string
}

/**
 * A sidebar row. Its end shows one thing: the inbox count (the sidebar's only vermilion fill), a
 * seat's state, an unread dot, or a muted meta count. Height follows density.
 */
export function SidebarItem({ children, active, unread, child, count, state, meta, avatar, asChild, className, ...props }: SidebarItemProps & Omit<ComponentProps<'div'>, 'children'>) {
  let end: ReactNode = null
  if (count != null)
    end = <span className="rounded-sm bg-brand px-1.5 text-[10.5px] leading-[17px] font-[650] text-on-brand tabular-nums">{count}</span>
  else if (state) end = <SeatState state={state} />
  else if (unread) end = <span role="img" aria-label="unread" className="size-1.5 rounded-full bg-held" />
  else if (meta != null) end = <span className="font-mono text-mono-ui text-muted-foreground tabular-nums">{meta}</span>
  const Comp = asChild ? Slot.Root : 'div'
  return (
    <Comp
      data-slot="sidebar-item"
      data-active={active || undefined}
      aria-current={active ? 'page' : undefined}
      role={asChild ? undefined : 'link'}
      tabIndex={asChild ? undefined : 0}
      className={cn(
        'flex min-h-row cursor-pointer items-center gap-2 rounded-sm px-2 whitespace-nowrap text-body transition-fast hover:bg-raised',
        active && 'bg-raised font-semibold text-text',
        unread && 'font-semibold text-text',
        child && 'pl-[22px]',
        className,
      )}
      {...props}
    >
      {avatar ? <Avatar {...avatar} /> : null}
      <Slot.Slottable>{children}</Slot.Slottable>
      {end ? <span className="ml-auto inline-flex items-center">{end}</span> : null}
    </Comp>
  )
}

/** A sidebar group header: mono, lowercase, after "// ". */
export function SidebarGroup({ children, className }: { children: ReactNode; className?: string }) {
  return <div className={cn("px-2 pt-3.5 pb-1 font-mono text-[10.5px] text-muted-foreground before:content-['//_']", className)}>{children}</div>
}

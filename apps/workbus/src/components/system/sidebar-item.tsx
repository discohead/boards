import type { ComponentProps, ReactNode } from 'react'
import { Slot } from 'radix-ui'
import { cn } from '@/lib/utils'
import { Avatar, type AvatarProps } from './avatar'
import { Icon, type IconProp } from './icon'
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
  /** A Lucide icon before the label, muted (Inbox, a channel's hash). */
  icon?: IconProp
  /** Render as the child element (a router Link), keeping the row's look. */
  asChild?: boolean
  className?: string
}

/**
 * A sidebar row. Its end shows one thing: the inbox count (the sidebar's only vermilion fill), a
 * seat's state, an unread dot, or a muted meta (a count or a handle). Height follows density. The
 * active row sits on surface with a line-strong edge, as in the prototype.
 */
export function SidebarItem({ children, active, unread, child, count, state, meta, avatar, icon, asChild, className, ...props }: SidebarItemProps & Omit<ComponentProps<'div'>, 'children'>) {
  let end: ReactNode = null
  if (count != null) end = <span className="rounded-xs bg-brand px-[5px] font-mono text-mono-label text-on-brand tabular-nums">{count}</span>
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
        'my-px flex h-row cursor-pointer items-center gap-2 rounded-sm px-[7px] font-[450] whitespace-nowrap text-body transition-fast hover:bg-raised [&>svg]:text-muted-foreground',
        active && 'bg-surface font-semibold text-text shadow-[inset_0_0_0_1px_var(--wb-line-strong)] hover:bg-surface [&>svg]:text-text',
        unread && 'font-semibold text-text',
        child && 'pl-6',
        className,
      )}
      {...props}
    >
      {avatar ? <Avatar {...avatar} /> : icon ? <Icon name={icon} /> : null}
      <Slot.Slottable>{children}</Slot.Slottable>
      {end ? <span className="ml-auto inline-flex items-center">{end}</span> : null}
    </Comp>
  )
}

/** A sidebar group header: mono, small capitals, tracked ("DIRECT MESSAGES", "TEAMS"). */
export function SidebarGroup({ children, className }: { children: ReactNode; className?: string }) {
  return <div className={cn('mx-1.5 mt-4 mb-[5px] font-mono text-mono-label tracking-[0.07em] text-muted-foreground uppercase', className)}>{children}</div>
}

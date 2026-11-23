import type { ReactNode } from 'react'
import { cn } from '@/lib/utils'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuShortcut,
  DropdownMenuTrigger,
  itemBase,
  menuSurface,
} from '@/components/ui/dropdown-menu'
import { Icon, type IconProp } from './icon'

export interface MenuItem {
  label: string
  icon?: IconProp
  kbd?: string
  danger?: boolean
  active?: boolean
  onSelect?: () => void
}
export interface MenuProps {
  items: (MenuItem | '-')[]
  /** With a trigger, the menu opens from it (Radix DropdownMenu); without, it draws in place. */
  trigger?: ReactNode
  align?: 'start' | 'center' | 'end'
  className?: string
}

/** A context or overflow menu: 28px items, the icon muted, the shortcut at the right, danger last. */
export function Menu({ items, trigger, align = 'start', className }: MenuProps) {
  if (trigger)
    return (
      <DropdownMenu>
        <DropdownMenuTrigger asChild>{trigger}</DropdownMenuTrigger>
        <DropdownMenuContent align={align} className={className}>
          {items.map((it, i) =>
            it === '-' ? (
              <DropdownMenuSeparator key={i} />
            ) : (
              <DropdownMenuItem key={i} variant={it.danger ? 'destructive' : 'default'} onSelect={it.onSelect}>
                {it.icon ? <Icon name={it.icon} size={14} /> : null}
                {it.label}
                {it.kbd ? <DropdownMenuShortcut>{it.kbd}</DropdownMenuShortcut> : null}
              </DropdownMenuItem>
            ),
          )}
        </DropdownMenuContent>
      </DropdownMenu>
    )
  return (
    <div role="menu" className={cn(menuSurface, 'w-56 max-w-full', className)}>
      {items.map((it, i) =>
        it === '-' ? (
          <div key={i} role="separator" className="-mx-1 my-1 h-px bg-line" />
        ) : (
          <div
            key={i}
            role="menuitem"
            tabIndex={-1}
            onClick={it.onSelect}
            className={cn(itemBase, 'hover:bg-raised', it.active && 'bg-raised', it.danger && 'text-danger [&_svg]:text-danger')}
          >
            {it.icon ? <Icon name={it.icon} size={14} /> : null}
            {it.label}
            {it.kbd ? <DropdownMenuShortcut>{it.kbd}</DropdownMenuShortcut> : null}
          </div>
        ),
      )}
    </div>
  )
}

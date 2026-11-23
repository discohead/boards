import type { ReactNode } from 'react'
import { Button as UIButton } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import { Icon, type IconProp } from './icon'
import { Kbd } from './kbd'

export interface ButtonProps {
  /** primary: the one main action in a view (vermilion). danger: destructive, crimson outline. */
  variant?: 'primary' | 'secondary' | 'outline' | 'ghost' | 'danger'
  size?: 'sm' | 'md' | 'lg'
  /** Keyboard shortcut shown inside the button, e.g. "⌘↵". */
  kbd?: string
  icon?: IconProp
  disabled?: boolean
  type?: 'button' | 'submit'
  title?: string
  onClick?: () => void
  className?: string
  children: ReactNode
}

const VARIANT = { primary: 'default', secondary: 'secondary', outline: 'outline', ghost: 'ghost', danger: 'destructive' } as const
const SIZE = { sm: 'sm', md: 'default', lg: 'lg' } as const

/** Runs one action. A verb for a label; primary once per view; the shortcut in kbd. */
export function Button({ variant = 'secondary', size = 'md', kbd, icon, type = 'button', children, className, ...props }: ButtonProps) {
  return (
    <UIButton variant={VARIANT[variant]} size={SIZE[size]} type={type} className={className} {...props}>
      {icon ? <Icon name={icon} size={14} /> : null}
      {children}
      {kbd ? <Kbd className={cn(variant === 'primary' && 'border-current/35 text-inherit')}>{kbd}</Kbd> : null}
    </UIButton>
  )
}

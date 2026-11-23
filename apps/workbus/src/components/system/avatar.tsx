import { cn } from '@/lib/utils'

export interface AvatarProps {
  /** person: round and ink. agent: square, in the agent color. */
  kind?: 'person' | 'agent'
  initials: string
  name?: string
  size?: 'xs' | 'sm' | 'md' | 'lg'
  className?: string
}

const SIZE = {
  xs: 'size-avatar-xs text-[8px]',
  sm: 'size-avatar-sm text-[9px]',
  md: 'size-avatar-md text-[10px]',
  lg: 'size-avatar-lg text-[14px]',
}

/** People are round, agents are square. No robot icon, no "AI" tag. */
export function Avatar({ kind = 'person', initials, name, size = 'sm', className }: AvatarProps) {
  const agent = kind === 'agent'
  return (
    <span
      data-slot="avatar"
      data-kind={kind}
      title={name}
      role={name ? 'img' : undefined}
      aria-label={name ? name + (agent ? ' (agent)' : '') : undefined}
      className={cn(
        'inline-grid flex-none place-items-center leading-none font-[650] tracking-normal',
        SIZE[size],
        agent ? 'bg-agent-soft text-agent' : 'rounded-full bg-text text-bg',
        agent && (size === 'lg' ? 'rounded-[5px]' : 'rounded-xs'),
        className,
      )}
    >
      {initials}
    </span>
  )
}

import { useState } from 'react'
import { cn } from '@/lib/utils'
import { Command, CommandDialog, CommandFooter, CommandGroup, CommandInput, CommandItem, CommandList } from '@/components/ui/command'
import { Kbd } from './kbd'
import { Avatar, type AvatarProps } from './avatar'
import { Icon, type IconProp } from './icon'
import { SeatState, TaskState, type SeatStateName, type TaskStateName } from './status'

export interface CommandPaletteItem {
  label: string
  path?: string
  kbd?: string
  active?: boolean
  icon?: IconProp
  task?: TaskStateName
  state?: SeatStateName
  avatar?: AvatarProps
  onSelect?: () => void
}
export interface CommandPaletteProps {
  query?: string
  groups: { name: string; items: CommandPaletteItem[] }[]
  /** Called as the query changes: the consumer searches and hands back groups. */
  onQueryChange?: (query: string) => void
  /** With open and onOpenChange, ⌘K draws as a dialog; without, in place. */
  open?: boolean
  onOpenChange?: (open: boolean) => void
  /** Whether asking @op works: the footer's "⇧↵ ask @op" hint shows only then. Defaults to true. */
  ask?: boolean
  className?: string
}

const key = (group: string, item: CommandPaletteItem) => group + '\u0000' + item.label

/**
 * ⌘K: seats, threads, docs, commands, then ask. The consumer provides the query and the groups,
 * already searched (cmdk's own filter is off). The active row has a 2px held inset bar.
 */
export function CommandPalette({ query, groups, onQueryChange, open, onOpenChange, ask = true, className }: CommandPaletteProps) {
  const [own, setOwn] = useState(query ?? '')
  const q = onQueryChange ? (query ?? '') : own
  const first = groups.flatMap((g) => g.items.filter((it) => it.active).map((it) => key(g.name, it)))[0]
  const [selected, setSelected] = useState(first ?? '')
  const body = (
    <>
      <CommandInput
        value={q}
        onValueChange={(v) => (onQueryChange ? onQueryChange(v) : setOwn(v))}
        placeholder={ask ? 'Type a command, search, or ask @op…' : 'Type a command or search…'}
        aria-label="Command"
      />
      <CommandList>
        {groups.map((g) => (
          <CommandGroup key={g.name} heading={g.name}>
            {g.items.map((it) => (
              <CommandItem key={it.label} value={key(g.name, it)} onSelect={it.onSelect}>
                {it.avatar ? <Avatar size="xs" {...it.avatar} /> : it.task ? <TaskState state={it.task} /> : it.icon ? <Icon name={it.icon} size={14} /> : null}
                {it.label}
                <span className="ml-auto inline-flex items-center gap-2">
                  {it.path ? <span className="font-mono text-mono-ui text-muted-foreground">{it.path}</span> : null}
                  {it.state ? <SeatState state={it.state} /> : null}
                  {it.kbd ? <Kbd>{it.kbd}</Kbd> : null}
                </span>
              </CommandItem>
            ))}
          </CommandGroup>
        ))}
      </CommandList>
      <CommandFooter>
        <span>↑↓ move</span>
        <span>↵ open</span>
        {ask ? <span>⇧↵ ask @op</span> : null}
        <span className="ml-auto">esc</span>
      </CommandFooter>
    </>
  )
  if (onOpenChange)
    return (
      <CommandDialog open={open} onOpenChange={onOpenChange} shouldFilter={false} className={className}>
        {body}
      </CommandDialog>
    )
  return (
    <Command
      shouldFilter={false}
      value={selected}
      onValueChange={setSelected}
      loop
      label="Command menu"
      className={cn('w-full max-w-[560px] border border-line shadow-float', className)}
    >
      {body}
    </Command>
  )
}

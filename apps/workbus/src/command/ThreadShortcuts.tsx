// The open thread's single keys (design/workbus.md §9.3): C makes it a task, A assigns that task.
// TanStack Hotkeys skips single keys while focus is in a text field, so typing a C or an A in a
// reply never fires them. Mount this in the thread pane with the open thread's ID.
import { useState } from 'react'
import { useLiveQuery } from '@tanstack/react-db'
import { useHotkey } from '@tanstack/react-hotkeys'
import { CommandDialog, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList } from '@/components/ui/command'
import { Avatar, toast } from '@/components/system'
import { useDocsBus } from '@/docs/bus'

export function ThreadShortcuts({ threadId, onNotice }: { threadId: string; onNotice?: (text: string) => void }) {
  const bus = useDocsBus()
  const [assigning, setAssigning] = useState(false)
  const { data: actors } = useLiveQuery((q) => q.from({ actor: bus.actors }))
  const { data: tasks } = useLiveQuery((q) => q.from({ task: bus.tasks }))
  // The board assigns a task to one of its owner's profiles (owner+name): those are who A offers.
  const owner = tasks.find((task) => task.id === threadId)?.task?.owner
  const assignable = owner ? actors.filter((actor) => actor.id.startsWith(owner + '+')) : []
  /** What happened, in a toast with the thread's cursor; a refusal stays until dismissed. */
  const notice = (text: string, failed = false) => (onNotice ? onNotice(text) : toast({ children: text, cursor: '#' + threadId, ...(failed ? { tone: 'danger' as const } : {}) }))

  useHotkey(
    'C',
    () => {
      if (bus.tasks.has(threadId)) return notice('This thread is a task already.')
      const tx = bus.threadActions.makeTask({ thread: threadId })
      tx.when('settled').then(
        () => notice('Made a task.'),
        (error: Error) => notice('Not made a task: ' + error.message, true),
      )
    },
    { meta: { name: 'Make this thread a task', group: 'Thread' } },
  )
  useHotkey(
    'A',
    () => {
      if (!bus.tasks.has(threadId)) return notice('Make it a task first (C), then assign it.')
      setAssigning(true)
    },
    { meta: { name: 'Assign this task', group: 'Thread' } },
  )

  const assign = (actor: string | null) => {
    setAssigning(false)
    const tx = bus.threadActions.assign({ task: threadId, for: actor })
    tx.when('settled').then(
      () => notice(actor ? 'Assigned to @' + (bus.actors.get(actor)?.handle ?? actor) + '.' : 'Unassigned.'),
      (error: Error) => notice('Not assigned: ' + error.message, true),
    )
  }

  return (
    <>
    <CommandDialog open={assigning} onOpenChange={setAssigning} title="Assign" description="Who should do this task">
      <CommandInput placeholder="Assign to…" data-testid="assign-input" />
      <CommandList data-testid="assign-list">
        <CommandEmpty>{assignable.length ? 'No one by that name.' : "No one to assign to: a task goes to one of its owner's profiles."}</CommandEmpty>
        <CommandGroup heading="Assign to">
          {assignable.map((actor) => (
            <CommandItem key={actor.id} value={actor.name + ' ' + actor.handle + ' ' + actor.id} onSelect={() => assign(actor.id)}>
              <Avatar size="xs" kind={actor.kind === 'person' ? 'person' : 'agent'} initials={actor.name.slice(0, 2).toUpperCase()} /> {actor.name} <span className="ml-auto font-mono text-mono-ui text-muted-foreground">@{actor.handle}</span>
            </CommandItem>
          ))}
          <CommandItem value="no one unassign" onSelect={() => assign(null)}>
            No one
          </CommandItem>
        </CommandGroup>
      </CommandList>
    </CommandDialog>
    </>
  )
}

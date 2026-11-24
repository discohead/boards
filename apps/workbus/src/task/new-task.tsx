// New task: a title and a channel, made at once (bus.actions.task.create), pending until the board
// answers. The view's one primary action.
import { useState } from 'react'
import { PlusIcon } from 'lucide-react'
import { useLiveQuery } from '@tanstack/react-db'
import { useBus } from '@/data'
import { Button } from '@/components/ui/button'
import { DropdownMenu, DropdownMenuContent, DropdownMenuTrigger } from '@/components/ui/dropdown-menu'

export function NewTask({ channel }: { channel?: string }) {
  const bus = useBus()
  const { data: channels } = useLiveQuery({ query: (q) => q.from({ channel: bus.channels }).orderBy(({ channel }) => channel.path, 'asc') })
  const [open, setOpen] = useState(false)
  const [text, setText] = useState('')
  const [where, setWhere] = useState(channel ?? '')
  const live = channels.filter((one) => !one.archived)
  const target = where || channel || live[0]?.path || ''
  return (
    <DropdownMenu open={open} onOpenChange={setOpen}>
      <DropdownMenuTrigger asChild>
        <Button size="xs">
          <PlusIcon />
          New task
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-80 p-2">
        <form
          className="flex flex-col gap-2"
          onSubmit={(event) => {
            event.preventDefault()
            if (!text.trim() || !target) return
            bus.actions.task.create({ channel: target, text: text.trim() })
            setText('')
            setOpen(false)
          }}
        >
          <input autoFocus aria-label="Task title" placeholder="What needs doing" value={text} onChange={(event) => setText(event.target.value)} onKeyDown={(event) => event.stopPropagation()} className="h-7 rounded-sm border bg-background px-2 text-sm" />
          <div className="flex items-center gap-2">
            <select aria-label="Channel" value={target} onChange={(event) => setWhere(event.target.value)} className="h-7 min-w-0 flex-1 rounded-sm border bg-background px-1 font-mono text-xs">
              {live.map((one) => (
                <option key={one.path} value={one.path}>
                  {one.path}
                </option>
              ))}
            </select>
            <Button size="xs" type="submit" disabled={!text.trim() || !target}>
              Make task
            </Button>
          </div>
        </form>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

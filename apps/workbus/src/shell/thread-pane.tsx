// The thread pane (design/workbus.md §9.3): the open thread's three faces, each where it applies:
// the conversation always, the status when it's a task, the body when it's a doc. Its open state
// is ?thread=<id>. The faces are in src/thread/, for their owners to fill in.
import { useEffect } from 'react'
import { useLiveQuery } from '@tanstack/react-db'
import { eq } from '@tanstack/db'
import { useBus } from '@/data'
import { Button } from '@/components/ui/button'
import { Conversation } from '@/thread/conversation'
import { Status } from '@/thread/status'
import { Body } from '@/thread/body'
import { ThreadShortcuts } from '@/command/ThreadShortcuts'
import { useOpenThread } from './open-thread.ts'
import type { Face } from '../routes/__root.tsx'

export function ThreadPane() {
  const { thread } = useOpenThread()
  if (!thread) return null
  return <Pane key={thread} id={thread} />
}

function Pane({ id }: { id: string }) {
  const { face, show, close } = useOpenThread()
  const bus = useBus()
  useEffect(() => {
    void bus.openThread(id)
    return () => void bus.closeThread(id)
  }, [bus, id])
  const { data: roots } = useLiveQuery({ query: (q) => q.from({ message: bus.messages }).where(({ message }) => eq(message.id, id)) })
  const root = roots[0]
  const faces: { id: Face; label: string }[] = [{ id: 'conversation', label: 'Conversation' }, ...(root?.task ? [{ id: 'task' as const, label: 'Task' }] : []), ...(root?.doc ? [{ id: 'doc' as const, label: 'Doc' }] : [])]
  const open: Face = faces.some((tab) => tab.id === face) ? face! : 'conversation'
  return (
    <aside aria-label="Thread" data-testid="thread-pane" className="flex w-[28rem] shrink-0 flex-col border-l">
      <header className="flex items-center gap-2 border-b px-4 py-2">
        <span className="text-sm font-medium">{root ? '#' + root.channel + ' · #' + id : '#' + id}</span>
        <Button variant="ghost" size="sm" className="ml-auto" onClick={close} aria-label="Close the thread">
          Close
        </Button>
      </header>
      {/* The faces it has, as tabs (designer's Tabs replaces these). A face it lacks is an add action, in its owner's view. */}
      <nav aria-label="Faces" className="flex gap-4 border-b px-4 text-sm">
        {faces.map((tab) => (
          <button key={tab.id} data-face={tab.id} aria-current={tab.id === open ? 'page' : undefined} onClick={() => show(tab.id)} className={'-mb-px border-b-2 py-2 ' + (tab.id === open ? 'border-foreground text-foreground' : 'border-transparent text-muted-foreground')}>
            {tab.label}
          </button>
        ))}
      </nav>
      <ThreadShortcuts threadId={id} />
      <div className="min-h-0 flex-1 overflow-y-auto">
        {open === 'task' && root?.task ? <Status root={root} /> : null}
        {open === 'doc' && root?.doc ? <Body root={root} /> : null}
        {open === 'conversation' ? <Conversation id={id} /> : null}
      </div>
    </aside>
  )
}

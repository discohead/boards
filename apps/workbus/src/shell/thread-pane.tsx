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
import { useOpenThread } from './open-thread.ts'

export function ThreadPane() {
  const { thread, close } = useOpenThread()
  if (!thread) return null
  return <Pane key={thread} id={thread} close={close} />
}

function Pane({ id, close }: { id: string; close: () => void }) {
  const bus = useBus()
  useEffect(() => {
    void bus.openThread(id)
    return () => void bus.closeThread(id)
  }, [bus, id])
  const { data: roots } = useLiveQuery({ query: (q) => q.from({ message: bus.messages }).where(({ message }) => eq(message.id, id)) })
  const root = roots[0]
  return (
    <aside aria-label="Thread" data-testid="thread-pane" className="flex w-[28rem] shrink-0 flex-col border-l">
      <header className="flex items-center gap-2 border-b px-4 py-2">
        <span className="text-sm font-medium">{root ? '#' + root.channel + ' · #' + id : '#' + id}</span>
        <Button variant="ghost" size="sm" className="ml-auto" onClick={close} aria-label="Close the thread">
          Close
        </Button>
      </header>
      <div className="min-h-0 flex-1 overflow-y-auto">
        {root?.task ? <Status root={root} /> : null}
        {root?.doc ? <Body root={root} /> : null}
        <Conversation id={id} />
      </div>
    </aside>
  )
}

// The thread pane (design/workbus.md §9.3): the open thread's three faces, each where it applies:
// the conversation always, the task when it's a task, the document when it's a doc, under its path
// and cursor, title, and facts row. Its open state is ?thread=<id>, its tab ?face=. The faces are in src/thread/, for their owners to fill in.
import { useEffect } from 'react'
import { useLiveQuery } from '@tanstack/react-db'
import { eq } from '@tanstack/db'
import { taskState, useBus } from '@/data'
import { X } from 'lucide-react'
import { HeldPill, Label, Tabs, TaskState } from '@/components/system'
import { Button } from '@/components/ui/button'
import { Conversation } from '@/thread/conversation'
import { Status } from '@/thread/status'
import { Body } from '@/thread/body'
import { ThreadShortcuts } from '@/command/ThreadShortcuts'
import { useAddFaces } from '@/thread/add-faces'
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
  const adding = useAddFaces(root, show)
  const faces: { id: Face; label: string }[] = [{ id: 'conversation', label: 'Conversation' }, ...(root?.task ? [{ id: 'task' as const, label: 'Task' }] : []), ...(root?.doc ? [{ id: 'doc' as const, label: 'Document' }] : [])]
  const open: Face = faces.some((tab) => tab.id === face) ? face! : 'conversation'
  const replies = useLiveQuery({ query: (q) => q.from({ thread: bus.threads }).where(({ thread }) => eq(thread.id, id)) }).data[0]?.replies
  const shown = root?.task ? taskState(root.task) : null
  const title = root?.doc?.title ?? root?.text.split('\n')[0]?.replace(/^#+\s*/, '') ?? ''
  const labels = Object.entries(root?.labels ?? {}).filter(([key]) => !key.startsWith('board.'))
  return (
    <aside aria-label="Thread" data-testid="thread-pane" className="flex min-w-0 flex-1 flex-col">
      <header className="px-5 pt-5">
        <div className="flex items-center justify-between">
          <span data-testid="thread-path" className="font-mono text-mono-ui text-muted-foreground">
            {root ? root.channel : '…'} <span aria-hidden>/</span> #{id}
          </span>
          <Button variant="ghost" size="icon-sm" onClick={close} aria-label="Close the thread">
            <X size={16} strokeWidth={1.5} aria-hidden />
          </Button>
        </div>
        <h2 data-testid="thread-title" className="mt-2 text-title-lg text-text">{title}</h2>
        <div data-testid="thread-facts" className="mt-2 flex flex-wrap items-center gap-2 font-mono text-mono-ui text-muted-foreground">
          {shown?.state === 'held' ? <span data-held><HeldPill kind="approval" /></span> : null}
          {shown && shown.state !== 'held' ? <span data-state={shown.state}><TaskState state={shown.state} label={shown.waitsOn?.length ? 'waits on #' + shown.waitsOn.join(', #') : shown.word} muted={shown.word === 'canceled'} /></span> : null}
          {root ? <span>@{root.author?.handle ?? root.by.actor.replace(/^.*:/, '')}</span> : null}
          {labels.map(([key, value]) => (
            <Label key={key} name={key} value={value} />
          ))}
        </div>
        <div aria-label="Faces" className="mt-4">
          <Tabs tabs={[...faces.map((tab) => ({ id: tab.id, label: tab.label, ...(tab.id === 'conversation' && replies !== undefined ? { count: replies + 1 } : {}) })), ...adding.tabs]} value={open} onChange={(id) => show(id as Face)} />
        </div>
        {adding.error ? <p role="alert" className="mt-1 text-xs text-destructive">{adding.error}</p> : null}
      </header>
      <ThreadShortcuts threadId={id} />
      <div className="flex min-h-0 flex-1 flex-col">
        {open === 'task' && root?.task ? <Status root={root} /> : null}
        {open === 'doc' && root?.doc ? <Body root={root} /> : null}
        {open === 'conversation' ? <Conversation id={id} /> : null}
      </div>
    </aside>
  )
}

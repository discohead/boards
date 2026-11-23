// The thread pane (design/workbus.md §9.3): the open thread's three faces, each where it applies:
// the conversation always, the task when it's a task, the document when it's a doc, under its path
// and cursor, title, and facts row. Its open state is ?thread=<id>, its tab ?face=. The faces are in src/thread/, for their owners to fill in.
import { useEffect } from 'react'
import { useLiveQuery } from '@tanstack/react-db'
import { eq } from '@tanstack/db'
import { taskState, useBus } from '@/data'
import { FileText, MessageSquare, SquareCheck, X, type LucideIcon } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Conversation } from '@/thread/conversation'
import { Status } from '@/thread/status'
import { Body } from '@/thread/body'
import { ThreadShortcuts } from '@/command/ThreadShortcuts'
import { AddFaces } from '@/thread/add-faces'
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
  const faces: { id: Face; label: string }[] = [{ id: 'conversation', label: 'Conversation' }, ...(root?.task ? [{ id: 'task' as const, label: 'Task' }] : []), ...(root?.doc ? [{ id: 'doc' as const, label: 'Document' }] : [])]
  const open: Face = faces.some((tab) => tab.id === face) ? face! : 'conversation'
  const replies = useLiveQuery({ query: (q) => q.from({ thread: bus.threads }).where(({ thread }) => eq(thread.id, id)) }).data[0]?.replies
  const shown = root?.task ? taskState(root.task) : null
  const title = root?.doc?.title ?? root?.text.split('\n')[0]?.replace(/^#+\s*/, '') ?? ''
  const labels = Object.entries(root?.labels ?? {}).filter(([key]) => !key.startsWith('board.'))
  const icons: Record<Face, LucideIcon> = { conversation: MessageSquare, task: SquareCheck, doc: FileText }
  return (
    <aside aria-label="Thread" data-testid="thread-pane" className="flex min-w-0 flex-1 flex-col">
      <header className="px-6 pt-5">
        <div className="flex items-center justify-between">
          <span data-testid="thread-path" className="font-mono text-xs text-muted-foreground">
            {root ? root.channel : '…'} <span aria-hidden>/</span> #{id}
          </span>
          <Button variant="ghost" size="icon-sm" onClick={close} aria-label="Close the thread">
            <X size={16} strokeWidth={1.5} aria-hidden />
          </Button>
        </div>
        <h2 data-testid="thread-title" className="mt-2 text-[21px] font-semibold tracking-tight">{title}</h2>
        <div data-testid="thread-facts" className="mt-2 flex flex-wrap items-center gap-2 font-mono text-xs text-muted-foreground">
          {shown?.state === 'held' ? <span data-held className="rounded-sm bg-primary/10 px-2 py-0.5 font-sans text-primary">Held for you</span> : null}
          {shown && shown.state !== 'held' ? <span data-state={shown.state} className="rounded-sm border px-1.5">{shown.word}</span> : null}
          {root ? <span>@{root.author?.handle ?? root.by.actor.replace(/^.*:/, '')}</span> : null}
          {labels.map(([key, value]) => (
            <span key={key} className="rounded-sm border px-1.5">
              {key}={value}
            </span>
          ))}
        </div>
        {root ? <AddFaces root={root} onFace={show} /> : null}
        <nav aria-label="Faces" className="mt-4 flex gap-5 border-b text-sm">
          {faces.map((tab) => {
            const Icon = icons[tab.id]
            return (
              <button key={tab.id} type="button" data-face={tab.id} aria-current={tab.id === open ? 'page' : undefined} onClick={() => show(tab.id)} className={'-mb-px flex items-center gap-1.5 border-b-2 py-2 ' + (tab.id === open ? 'border-foreground font-medium text-foreground' : 'border-transparent text-muted-foreground')}>
                <Icon size={16} strokeWidth={1.5} aria-hidden />
                {tab.label}
                {tab.id === 'conversation' && replies !== undefined ? <span className="rounded-sm border px-1 font-mono text-[11px]">{replies + 1}</span> : null}
              </button>
            )
          })}
        </nav>
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

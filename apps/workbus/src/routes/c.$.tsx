// A channel: its threads, newest first, live, in the list pane, and a box to start one. Opening a
// thread sets ?thread=<id>. A stub for the channels' owner (threads), in the prototype's row shape.
import { useEffect, useState } from 'react'
import { createFileRoute } from '@tanstack/react-router'
import { useLiveQuery } from '@tanstack/react-db'
import { eq } from '@tanstack/db'
import { useBus } from '@/data'
import { ListPane } from '@/shell/list-pane'
import { useOpenThread } from '@/shell/open-thread'
import { cn } from '@/lib/utils'
import { Clock } from '@/shell/clock'

export const Route = createFileRoute('/c/$')({ component: Channel })

function Channel() {
  const channel = Route.useParams()._splat ?? ''
  const bus = useBus()
  const { thread: openId, open } = useOpenThread()
  // The first pages are the whole board's newest; a channel reads its own (on the server too, for a deep link).
  useEffect(() => void bus.openChannel(channel), [bus, channel])
  const { data: threads } = useLiveQuery({ query: (q) => q.from({ thread: bus.threads }).where(({ thread }) => eq(thread.channel, channel)).orderBy(({ thread }) => thread.root.createdAt, 'desc') })
  const [text, setText] = useState('')
  return (
    <ListPane title={channel} label={'#' + channel + ' threads'}>
      <form
        className="border-b px-4 py-2"
        onSubmit={(event) => {
          event.preventDefault()
          if (!text.trim()) return
          bus.actions.post({ channel, text })
          setText('')
        }}
      >
        <input aria-label={'Post in ' + channel} name="text" value={text} placeholder={'Post in ' + channel + '…'} onChange={(event) => setText(event.target.value)} className="w-full bg-transparent text-sm outline-none placeholder:text-muted-foreground" />
      </form>
      <ul data-testid="threads">
        {threads.map((thread) => (
          <li key={thread.id} data-id={thread.id} data-pending={thread.root.pending ? 'yes' : undefined}>
            <button type="button" onClick={() => open(thread.id)} aria-current={thread.id === openId ? 'true' : undefined} className={cn('block w-full border-b border-line px-4 py-2.5 text-left hover:bg-raised', thread.id === openId && 'bg-selected shadow-[inset_2px_0_var(--wb-held)]')}>
              <span className="flex justify-between gap-2">
                <span className={cn('truncate text-sm', thread.root.pending ? 'text-muted-foreground' : 'font-medium')}>{thread.root.text.split('\n')[0]}</span>
                <span className="shrink-0 font-mono text-xs text-muted-foreground">{thread.root.pending ? 'sending…' : <Clock at={thread.root.createdAt} />}</span>
              </span>
              <span className="mt-0.5 block font-mono text-xs text-muted-foreground">
                @{thread.root.author?.handle ?? thread.root.by.actor.replace(/^.*:/, '')} · #{thread.root.pending ? '…' : thread.id} · {thread.replies} {thread.replies === 1 ? 'reply' : 'replies'}
              </span>
            </button>
          </li>
        ))}
      </ul>
    </ListPane>
  )
}

// A channel: its threads, newest first, live, and a box to start one. Opening a thread sets
// ?thread=<id>. A stub for the channels' owner, enough to prove the data layer on screen.
import { useEffect, useState } from 'react'
import { createFileRoute } from '@tanstack/react-router'
import { useLiveQuery } from '@tanstack/react-db'
import { eq } from '@tanstack/db'
import { useBus } from '@/data'
import { Button } from '@/components/ui/button'
import { useOpenThread } from '@/shell/open-thread'

export const Route = createFileRoute('/c/$')({ component: Channel })

function Channel() {
  const channel = Route.useParams()._splat ?? ''
  const bus = useBus()
  const { open } = useOpenThread()
  const { data: threads } = useLiveQuery({ query: (q) => q.from({ thread: bus.threads }).where(({ thread }) => eq(thread.channel, channel)).orderBy(({ thread }) => thread.root.createdAt, 'desc') })
  // The first pages are the whole board's newest; a channel reads its own (on the server too, for a deep link).
  useEffect(() => void bus.openChannel(channel), [bus, channel])
  const [text, setText] = useState('')
  return (
    <div className="p-6 text-sm">
      <h1 className="mb-4 text-lg font-semibold"># {channel}</h1>
      <form
        className="mb-4 flex gap-2"
        onSubmit={(event) => {
          event.preventDefault()
          if (!text.trim()) return
          bus.actions.post({ channel, text })
          setText('')
        }}
      >
        <input aria-label={'Post in #' + channel} name="text" value={text} onChange={(event) => setText(event.target.value)} className="w-96 rounded-md border px-2 py-1" />
        <Button size="sm">Post</Button>
      </form>
      <ul data-testid="threads" className="divide-y">
        {threads.map((thread) => (
          <li key={thread.id} data-id={thread.id} data-pending={thread.root.pending ? 'yes' : undefined}>
            <button className="w-full py-2 text-left hover:bg-accent" onClick={() => open(thread.id)}>
              {thread.root.text} <span className="text-muted-foreground">({thread.replies})</span>
            </button>
          </li>
        ))}
      </ul>
    </div>
  )
}

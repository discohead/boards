// Not a view: a page that shows the data layer working in the browser (live threads, an
// optimistic post), for checking it by hand and from a headless browser. Step 4's views replace it.
import { useState } from 'react'
import { createFileRoute } from '@tanstack/react-router'
import { useLiveQuery } from '@tanstack/react-db'
import { browserBus } from '@/bus-client'

export const Route = createFileRoute('/data')({
  ssr: false,
  loader: async () => {
    const bus = browserBus()
    await Promise.all([bus.ready, bus.threads.collection.preload(), bus.messages.collection.preload()])
    return null
  },
  component: DataCheck,
})

function DataCheck() {
  const bus = browserBus()
  const { data: threads } = useLiveQuery((q) => q.from({ thread: bus.threads.collection }).orderBy(({ thread }) => thread.root.createdAt, 'desc'))
  const [text, setText] = useState('')
  const [outcome, setOutcome] = useState('')
  const send = () => {
    const tx = bus.actions.post({ channel: 'general', text })
    setText('')
    tx.when('settled').then(
      () => setOutcome('settled'),
      (error: Error) => setOutcome('rolled back: ' + error.message),
    )
  }
  return (
    <main className="p-8 text-sm">
      <form onSubmit={(event) => (event.preventDefault(), send())} className="mb-4 flex gap-2">
        <input name="text" value={text} onChange={(event) => setText(event.target.value)} className="w-96 rounded-md border px-2 py-1" />
        <button className="rounded-md bg-primary px-3 py-1 text-primary-foreground">Post</button>
        <output data-testid="outcome">{outcome}</output>
      </form>
      <ul data-testid="threads">
        {threads.map((thread) => (
          <li key={thread.id} data-id={thread.id} data-pending={thread.root.pending ? 'yes' : undefined}>
            #{thread.id} {thread.root.text} ({thread.replies})
          </li>
        ))}
      </ul>
    </main>
  )
}

// The thread pane's conversation: the root and its replies, live, and a reply box. A stub: the thread
// pane's owner builds it out.
import { useState } from 'react'
import { useLiveQuery } from '@tanstack/react-db'
import { eq, or } from '@tanstack/db'
import { useBus } from '@/data'
import { Button } from '@/components/ui/button'

export function Conversation({ id }: { id: string }) {
  const bus = useBus()
  const { data: messages } = useLiveQuery({ query: (q) => q.from({ message: bus.messages }).where(({ message }) => or(eq(message.id, id), eq(message.re, id))).orderBy(({ message }) => message.createdAt, 'asc') })
  const [text, setText] = useState('')
  return (
    <section aria-label="Conversation" className="p-4 text-sm">
      <ol data-testid="conversation" className="space-y-2">
        {messages.map((message) => (
          <li key={message.id} data-id={message.id} data-pending={message.pending ? 'yes' : undefined}>
            <span className="text-muted-foreground">{message.by.actor.replace(/^.*:/, '')}</span> {message.text}
          </li>
        ))}
      </ol>
      <form
        className="mt-4 flex gap-2"
        onSubmit={(event) => {
          event.preventDefault()
          if (!text.trim()) return
          bus.actions.post({ re: id, text })
          setText('')
        }}
      >
        <input aria-label="Reply" value={text} onChange={(event) => setText(event.target.value)} className="min-w-0 flex-1 rounded-md border px-2 py-1" />
        <Button size="sm">Reply</Button>
      </form>
    </section>
  )
}

// The thread pane's conversation: the root and its replies, live, and the composer. A stub in the
// prototype's shape (name, @handle, time · #cursor; "Posting as"); the thread pane's owner builds it
// out with designer's Message.
import { useState } from 'react'
import { useLiveQuery } from '@tanstack/react-db'
import { eq, or } from '@tanstack/db'
import { useBus, type Message } from '@/data'
import { Button } from '@/components/ui/button'
import { Clock } from '@/shell/clock'

function Row({ message }: { message: Message }) {
  const handle = message.author?.handle ?? message.by.actor.replace(/^.*:/, '')
  const agent = message.author?.kind !== undefined && message.author.kind !== 'person'
  return (
    <li data-id={message.id} data-pending={message.pending ? 'yes' : undefined} className="flex gap-3">
      <span aria-hidden className={'mt-0.5 flex size-7 shrink-0 items-center justify-center text-[11px] font-medium ' + (agent ? 'rounded-[3px] bg-accent text-foreground' : 'rounded-full bg-foreground text-background')}>
        {(message.author?.name ?? handle).slice(0, 2).toUpperCase()}
      </span>
      <div className="min-w-0 flex-1">
        <div className="flex items-baseline gap-2">
          <strong className="text-sm">{message.author?.name ?? handle}</strong>
          <span className="font-mono text-xs text-muted-foreground">@{handle}</span>
          <span className="ml-auto font-mono text-xs text-muted-foreground">{message.pending ? 'sending…' : <><Clock at={message.createdAt} seconds /> · #{message.id}</>}</span>
        </div>
        <p className={'mt-0.5 whitespace-pre-wrap text-sm ' + (message.pending ? 'text-muted-foreground' : '')}>{message.text}</p>
      </div>
    </li>
  )
}

export function Conversation({ id }: { id: string }) {
  const bus = useBus()
  const { data: messages } = useLiveQuery({ query: (q) => q.from({ message: bus.messages }).where(({ message }) => or(eq(message.id, id), eq(message.re, id))).orderBy(({ message }) => message.createdAt, 'asc') })
  const [text, setText] = useState('')
  const send = () => {
    if (!text.trim()) return
    bus.actions.post({ re: id, text })
    setText('')
  }
  return (
    <section aria-label="Conversation" className="flex min-h-0 flex-1 flex-col">
      <ol data-testid="conversation" className="min-h-0 flex-1 space-y-4 overflow-y-auto px-6 py-4">
        {messages.map((message) => (
          <Row key={message.id} message={message} />
        ))}
      </ol>
      <form
        className="m-4 mt-0 rounded-md border px-3 py-2"
        onSubmit={(event) => {
          event.preventDefault()
          send()
        }}
      >
        <textarea
          aria-label="Reply"
          rows={1}
          value={text}
          placeholder="Reply to thread…"
          onChange={(event) => setText(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) (event.preventDefault(), send())
          }}
          className="w-full resize-none bg-transparent text-sm outline-none placeholder:text-muted-foreground"
        />
        <div className="flex items-center justify-between font-mono text-xs text-muted-foreground">
          <span>Posting as @{bus.runtime.me.handle ?? ''}</span>
          <Button size="sm" variant="outline" type="submit">
            Send <kbd className="ml-1 rounded-sm border px-1 font-mono text-[10.5px]">⌘↵</kbd>
          </Button>
        </div>
      </form>
    </section>
  )
}

// The thread pane's conversation: the root and its replies, live, and the composer. A stub in the
// prototype's shape (name, @handle, time · #cursor; "Posting as"); the thread pane's owner builds it
// out with designer's Message.
import { useEffect, useRef, useState } from 'react'
import { useLiveQuery } from '@tanstack/react-db'
import { eq, or } from '@tanstack/db'
import { useBus, type Message as BoardMessage } from '@/data'
import { Button } from '@/components/ui/button'
import { useClockText } from '@/shell/clock'
import { Kbd, Message } from '@/components/system'

const initials = (name: string) => name.split(/[\s._-]+/).map((part) => part[0] ?? '').join('').slice(0, 2).toUpperCase() || '?'

function Row({ message, arrive }: { message: BoardMessage; arrive: boolean }) {
  const handle = message.author?.handle ?? message.by.actor.replace(/^.*:/, '')
  const name = message.author?.name ?? handle
  const time = useClockText(message.createdAt, true)
  return (
    <li data-id={message.id} data-pending={message.pending ? 'yes' : undefined}>
      <Message author={{ name, handle: '@' + handle, initials: initials(name), kind: message.author?.kind !== undefined && message.author.kind !== 'person' ? 'agent' : 'person' }} time={time} {...(message.pending ? { pending: true } : { cursor: '#' + message.id })} arrive={arrive}>
        <p className="whitespace-pre-wrap">{message.text}</p>
      </Message>
    </li>
  )
}

export function Conversation({ id }: { id: string }) {
  const bus = useBus()
  const { data: messages } = useLiveQuery({ query: (q) => q.from({ message: bus.messages }).where(({ message }) => or(eq(message.id, id), eq(message.re, id))).orderBy(({ message }) => message.createdAt, 'asc') })
  // What was here when the thread opened; anything someone else adds after gets the arrival tint once.
  const seen = useRef<Set<string> | null>(null)
  if (seen.current === null) seen.current = new Set(messages.map((message) => message.id))
  useEffect(() => {
    const timer = setTimeout(() => messages.forEach((message) => seen.current!.add(message.id)), 300)
    return () => clearTimeout(timer)
  }, [messages])
  const [text, setText] = useState('')
  const send = () => {
    if (!text.trim()) return
    bus.actions.post({ re: id, text })
    setText('')
  }
  return (
    <section aria-label="Conversation" className="flex min-h-0 flex-1 flex-col">
      <ol data-testid="conversation" className="min-h-0 flex-1 overflow-y-auto py-3">
        {messages.map((message) => (
          <Row key={message.id} message={message} arrive={!seen.current!.has(message.id) && !message.pending && message.by.actor !== bus.runtime.me.actor} />
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
            Send <Kbd className="ml-1">⌘↵</Kbd>
          </Button>
        </div>
      </form>
    </section>
  )
}

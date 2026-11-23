// One message, as Slack shows one: who and when, the text as Markdown, reactions, and on hover the
// things one can do to it (react, reply in its thread, and edit or delete one's own). A root in a
// channel also shows its thread: how many replies, who replied, and when the last one came.
import { useEffect, useRef, useState, type ReactNode } from 'react'
import { MessageSquare, Pencil, SmilePlus, Trash2 } from 'lucide-react'
import { useBus, type Message, type Thread } from '@/data'
import { MessageText } from '@/thread/message-text'
import { handleOf, typedText } from '@/thread/mentions'
import { cn } from '@/lib/utils'
import { Clock } from '@/shell/clock'
import { Avatar as SystemAvatar } from '@/components/system'
import { REACTIONS, Reaction } from './reactions.tsx'

/** An actor's avatar: the design system's (people round, agents square), from what the app knows of it. */
export function Avatar({ actor, size = 'md' }: { actor: string; size?: 'sm' | 'md' }) {
  const bus = useBus()
  const known = bus.actors.get(actor)
  const name = known?.name ?? handleOf(bus.actors, actor)
  const initials = name.split(/[\s._-]+/).filter(Boolean).slice(0, 2).map((part) => part[0]!.toUpperCase()).join('') || '?'
  return <SystemAvatar kind={isAgent(known?.kind, actor) ? 'agent' : 'person'} initials={initials} name={name} size={size === 'sm' ? 'xs' : 'md'} />
}

/** An actor is an agent unless it's a person: a person's kind is "person", and people sign in as workbus:user: or access:user:. */
export const isAgent = (kind: string | undefined, actor: string) => (kind ? kind !== 'person' : !/^(workbus|access):user:/.test(actor))

/** A clock time from the log (shell's Clock: UTC on the server, local in the browser). */
export function When({ iso, className }: { iso: string; className?: string }) {
  return (
    <span className={className}>
      <Clock at={iso} />
    </span>
  )
}

/** Who replied in a thread, newest first, from the replies the app has. The last reply is always there. */
export function repliers(thread: Thread, replies: Message[]) {
  const seen: string[] = []
  for (const reply of [...(thread.last ? [thread.last] : []), ...[...replies].reverse()]) if (!reply.deleted && !seen.includes(reply.by.actor)) seen.push(reply.by.actor)
  return seen.slice(0, 5)
}

export function MessageItem({ message, grouped, thread, replies = [], onOpenThread, editing, onEditing, unreadReplies, arrive }: {
  message: Message
  /** Under the same author's message just before it: no header. */
  grouped?: boolean
  /** The thread this message is the root of, in a channel list. */
  thread?: Thread
  replies?: Message[]
  onOpenThread?: () => void
  editing?: boolean
  onEditing?: (on: boolean) => void
  unreadReplies?: number
  /** Someone else's, just come in the feed: one brief tint. */
  arrive?: boolean
}) {
  const bus = useBus()
  const me = bus.runtime.me.actor
  const mine = message.by.actor === me
  const [picking, setPicking] = useState(false)
  const [confirming, setConfirming] = useState(false)
  // A menu opens upward when there's room above, so the list's bottom edge never cuts it off.
  const [up, setUp] = useState(true)
  const toolbar = useRef<HTMLDivElement>(null)
  // A menu closes on Escape or a click elsewhere.
  useEffect(() => {
    if (!picking && !confirming) return
    const close = (event: Event) => {
      if (event instanceof KeyboardEvent ? event.key === 'Escape' : !toolbar.current?.contains(event.target as Node)) {
        setPicking(false)
        setConfirming(false)
      }
    }
    document.addEventListener('keydown', close)
    document.addEventListener('mousedown', close)
    return () => {
      document.removeEventListener('keydown', close)
      document.removeEventListener('mousedown', close)
    }
  }, [picking, confirming])
  const opening = (open: (on: boolean) => void) => () => {
    setUp((toolbar.current?.getBoundingClientRect().top ?? 999) > 260)
    open(true)
  }
  const name = message.author?.name ?? handleOf(bus.actors, message.by.actor)
  const handle = message.author?.handle ?? handleOf(bus.actors, message.by.actor)
  const reactions = Object.entries(message.reactions as Record<string, string[]>).filter(([, by]) => Array.isArray(by) && by.length > 0)
  const react = (emoji: string, remove: boolean) => {
    setPicking(false)
    bus.actions.react({ id: message.id, emoji, remove })
  }
  if (message.deleted)
    return (
      <div data-id={message.id} data-deleted="yes" className="flex gap-2 px-4 py-1 text-sm italic text-muted-foreground">
        <span className="w-8 shrink-0" />
        This message was deleted.
        {thread && thread.replies > 0 ? <ThreadLine thread={thread} replies={replies} onOpen={onOpenThread} unread={unreadReplies} /> : null}
      </div>
    )
  return (
    <div data-id={message.id} data-pending={message.pending ? 'yes' : undefined} data-arrive={arrive ? 'yes' : undefined} className={cn('group relative flex gap-2 px-4 text-[13px] leading-[18px] hover:bg-accent', grouped ? 'py-0.5' : 'pt-2 pb-0.5', message.pending && 'text-muted-foreground', arrive && 'animate-arrive')}>
      {grouped ? <When iso={message.createdAt} className="invisible w-7 shrink-0 text-right font-mono text-[10px] leading-[18px] tabular-nums text-muted-foreground group-hover:visible" /> : <Avatar actor={message.by.actor} />}
      <div className="min-w-0 flex-1">
        {grouped ? null : (
          <div className="flex items-baseline gap-2">
            <span className="font-semibold" data-testid="author">{name}</span>
            <span className="font-mono text-[11px] text-muted-foreground">@{handle}</span>
            <span className="ml-auto flex gap-2 font-mono text-[11px] tabular-nums text-muted-foreground">
              {message.pending ? <span data-testid="sending">sending…</span> : <span data-testid="cursor">#{message.id}</span>}
              <When iso={message.createdAt} />
            </span>
          </div>
        )}
        {editing ? (
          <EditBox message={message} onDone={() => onEditing?.(false)} />
        ) : (
          <div>
            <MessageText text={message.text} />
            {message.editedAt ? <span className="text-[11px] text-muted-foreground">(edited)</span> : null}
          </div>
        )}
        {reactions.length ? (
          <div className="mt-1 flex flex-wrap gap-1" data-testid="reactions">
            {reactions.map(([emoji, by]) => {
              const reacted = by.includes(me)
              return (
                <button key={emoji} type="button" data-emoji={emoji} aria-pressed={reacted} title={by.map((actor) => handleOf(bus.actors, actor)).join(', ')} onClick={() => react(emoji, reacted)} className={cn('flex h-5 items-center gap-1 rounded-sm border px-1.5 font-mono text-[11px] tabular-nums', reacted ? 'border-primary text-primary' : 'bg-background text-muted-foreground hover:border-foreground/30')}>
                  <Reaction name={emoji} />
                  <span>{by.length}</span>
                </button>
              )
            })}
          </div>
        ) : null}
        {thread && thread.replies > 0 ? <ThreadLine thread={thread} replies={replies} onOpen={onOpenThread} unread={unreadReplies} /> : null}
      </div>
      {editing || message.pending ? null : (
        <div className={cn('absolute -top-3 right-4 hidden items-center rounded-md border bg-background shadow-sm group-hover:flex focus-within:flex', (picking || confirming) && 'flex')} role="toolbar" aria-label="Message actions" ref={toolbar}>
          <Tool label="Add a reaction" onClick={picking ? () => setPicking(false) : opening(setPicking)}>
            <SmilePlus size={16} strokeWidth={1.5} />
          </Tool>
          {onOpenThread ? (
            <Tool label="Reply in thread" onClick={onOpenThread}>
              <MessageSquare size={16} strokeWidth={1.5} />
            </Tool>
          ) : null}
          {mine ? (
            <>
              <Tool label="Edit" onClick={() => onEditing?.(true)}>
                <Pencil size={16} strokeWidth={1.5} />
              </Tool>
              <Tool label="Delete" onClick={opening(setConfirming)}>
                <Trash2 size={16} strokeWidth={1.5} />
              </Tool>
            </>
          ) : null}
          {picking ? (
            <div className={cn('absolute right-0 z-20', up ? 'bottom-full mb-1' : 'top-full mt-1') + ' grid w-48 grid-cols-6 gap-1 rounded-md border bg-popover p-1 shadow-md'} role="menu" aria-label="Reactions">
              {REACTIONS.map((emoji) => (
                <button key={emoji} type="button" role="menuitem" aria-label={emoji.replace('_', ' ')} title={emoji.replace('_', ' ')} className="flex items-center justify-center rounded-sm p-1.5 hover:bg-accent" onClick={() => react(emoji, (message.reactions as Record<string, string[]>)[emoji]?.includes(me) ?? false)}>
                  <Reaction name={emoji} />
                </button>
              ))}
            </div>
          ) : null}
          {confirming ? (
            <div className={cn('absolute right-0 z-20', up ? 'bottom-full mb-1' : 'top-full mt-1') + ' w-56 rounded-md border bg-popover p-2 text-sm shadow-md'} role="alertdialog" aria-label="Delete this message?">
              <p>Delete this message?</p>
              <div className="mt-2 flex justify-end gap-2">
                <button type="button" className="rounded px-2 py-0.5 text-xs" onClick={() => setConfirming(false)} autoFocus>
                  Cancel
                </button>
                <button
                  type="button"
                  className="rounded-sm border border-destructive px-2 py-0.5 text-xs text-destructive"
                  onClick={() => {
                    setConfirming(false)
                    bus.actions.remove({ id: message.id })
                  }}
                >
                  Delete
                </button>
              </div>
            </div>
          ) : null}
        </div>
      )}
    </div>
  )
}

function Tool({ label, onClick, children }: { label: string; onClick: () => void; children: ReactNode }) {
  return (
    <button type="button" aria-label={label} title={label} onClick={onClick} className="p-1.5 text-muted-foreground hover:bg-accent hover:text-foreground">
      {children}
    </button>
  )
}

function ThreadLine({ thread, replies, onOpen, unread }: { thread: Thread; replies: Message[]; onOpen?: () => void; unread?: number }) {
  const who = repliers(thread, replies)
  return (
    <button type="button" onClick={onOpen} data-testid="thread-line" className="mt-1 flex w-fit items-center gap-2 rounded-md border border-transparent px-1 py-0.5 text-xs not-italic hover:border-border hover:bg-background">
      <span className="flex -space-x-1">
        {who.map((actor) => (
          <Avatar key={actor} actor={actor} size="sm" />
        ))}
      </span>
      <span className="font-semibold text-foreground" data-testid="reply-count">
        {thread.replies} {thread.replies === 1 ? 'reply' : 'replies'}
      </span>
      {unread ? <span className="size-2 rounded-full bg-primary" aria-label={unread + ' unread'} data-testid="thread-unread" /> : null}
      {thread.last ? (
        <span className="text-muted-foreground">
          Last reply <When iso={thread.last.createdAt} />
        </span>
      ) : null}
    </button>
  )
}

/** Editing in place: Enter saves, Shift+Enter is a new line, Escape leaves it as it was. */
function EditBox({ message, onDone }: { message: Message; onDone: () => void }) {
  const bus = useBus()
  const [text, setText] = useState(() => typedText(message.text, bus.actors))
  const save = () => {
    if (text.trim() && text !== typedText(message.text, bus.actors)) bus.actions.edit({ id: message.id, text })
    onDone()
  }
  return (
    <div className="mt-1 rounded-lg border bg-background focus-within:ring-1 focus-within:ring-ring">
      <textarea
        aria-label="Edit message"
        autoFocus
        value={text}
        rows={Math.min(10, text.split('\n').length)}
        onChange={(event) => setText(event.target.value)}
        onFocus={(event) => event.currentTarget.setSelectionRange(text.length, text.length)}
        onKeyDown={(event) => {
          if (event.nativeEvent.isComposing) return
          if (event.key === 'Escape') {
            event.preventDefault()
            onDone()
          } else if (event.key === 'Enter' && !event.shiftKey) {
            event.preventDefault()
            save()
          }
        }}
        className="block w-full resize-none bg-transparent px-3 py-2 text-sm outline-none"
      />
      <div className="flex justify-end gap-2 px-3 pb-1.5 text-xs">
        <button type="button" onClick={onDone}>
          Cancel
        </button>
        <button type="button" onClick={save} className="rounded bg-primary px-2 py-0.5 text-primary-foreground">
          Save
        </button>
      </div>
    </div>
  )
}

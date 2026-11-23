// The box a message is written in (Slack's): Enter sends, Shift+Enter is a new line, and what's
// typed is kept per place (a channel, a thread) until it's sent, across reloads. Typing @ offers
// the board's actors by handle; arrows pick, Enter or Tab puts one in, Escape closes the list.
import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react'
import { useLiveQuery } from '@tanstack/react-db'
import { useBus } from '@/data'
import { cn } from '@/lib/utils'
import { Kbd } from '@/components/system'

const draftKey = (key: string) => 'workbus:draft:' + key
const readDraft = (key: string) => {
  try {
    return localStorage.getItem(draftKey(key)) ?? ''
  } catch {
    return ''
  }
}
const keepDraft = (key: string, text: string) => {
  try {
    if (text) localStorage.setItem(draftKey(key), text)
    else localStorage.removeItem(draftKey(key))
  } catch {}
}

/** The @word being typed at the caret, if any. */
const typing = (text: string, caret: number) => /(?:^|[\s(])@([a-z0-9_.+-]{0,40})$/i.exec(text.slice(0, caret))

export { Kbd }

export function Composer({ place, label, placeholder, onSend, onEditLast, autoFocus }: { place: string; label: string; placeholder?: string; onSend: (text: string) => void; onEditLast?: () => void; autoFocus?: boolean }) {
  const bus = useBus()
  const [text, setText] = useState('')
  const [caret, setCaret] = useState(0)
  const [pick, setPick] = useState(0)
  const [closed, setClosed] = useState(false)
  const box = useRef<HTMLTextAreaElement>(null)
  // The draft is read after hydration: the server never has it.
  useEffect(() => {
    setText(readDraft(place))
    setClosed(false)
  }, [place])
  useEffect(() => {
    const element = box.current
    if (!element) return
    element.style.height = 'auto'
    element.style.height = Math.min(element.scrollHeight, 240) + 'px'
  }, [text])

  const { data: actors } = useLiveQuery({ query: (q) => q.from({ actor: bus.actors }) })
  const word = typing(text, caret)
  const offered = useMemo(() => {
    if (!word || closed) return []
    const prefix = word[1]!.toLowerCase()
    return actors.filter((actor) => actor.handle.toLowerCase().startsWith(prefix) || actor.name.toLowerCase().startsWith(prefix)).slice(0, 6)
  }, [word?.[1], closed, actors])

  const change = (value: string, at: number) => {
    setText(value)
    setCaret(at)
    setPick(0)
    setClosed(false)
    keepDraft(place, value)
  }
  const insert = (handle: string) => {
    if (!word) return
    const start = caret - word[1]!.length
    const value = text.slice(0, start) + handle + ' ' + text.slice(caret)
    change(value, start + handle.length + 1)
    requestAnimationFrame(() => box.current?.setSelectionRange(start + handle.length + 1, start + handle.length + 1))
  }
  const send = () => {
    if (!text.trim()) return
    onSend(text)
    change('', 0)
  }
  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.nativeEvent.isComposing) return
    if (offered.length) {
      if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        event.preventDefault()
        setPick((at) => (at + (event.key === 'ArrowDown' ? 1 : offered.length - 1)) % offered.length)
        return
      }
      if (event.key === 'Enter' || event.key === 'Tab') {
        event.preventDefault()
        insert(offered[pick]!.handle)
        return
      }
      if (event.key === 'Escape') {
        event.preventDefault()
        setClosed(true)
        return
      }
    }
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault()
      send()
    } else if (event.key === 'ArrowUp' && !text && onEditLast) {
      event.preventDefault()
      onEditLast()
    }
  }
  return (
    <div className="relative">
      {offered.length ? (
        <ul role="listbox" aria-label="Mention someone" data-testid="mention-list" className="absolute bottom-full left-0 z-10 mb-1 w-64 rounded-md border bg-popover p-1 text-sm shadow-md">
          {offered.map((actor, at) => (
            <li key={actor.id} role="option" aria-selected={at === pick}>
              <button
                type="button"
                className={cn('flex w-full items-center gap-2 rounded px-2 py-1 text-left', at === pick && 'bg-accent')}
                onMouseDown={(event) => {
                  event.preventDefault()
                  insert(actor.handle)
                }}
              >
                <span className="font-mono">@{actor.handle}</span>
                <span className="truncate text-muted-foreground">{actor.name}</span>
              </button>
            </li>
          ))}
        </ul>
      ) : null}
      <div className="rounded-lg border bg-background focus-within:ring-1 focus-within:ring-ring">
        <textarea
          ref={box}
          aria-label={label}
          rows={1}
          value={text}
          autoFocus={autoFocus}
          placeholder={placeholder}
          onChange={(event) => change(event.target.value, event.target.selectionStart)}
          onSelect={(event) => setCaret(event.currentTarget.selectionStart)}
          onKeyDown={onKeyDown}
          className="block max-h-60 w-full resize-none bg-transparent px-3 py-2 text-sm outline-none"
        />
        <div className="flex items-center justify-between px-3 pb-1.5 text-[11px] text-muted-foreground">
          <span className="flex items-center gap-1">
            <Kbd>↵</Kbd> sends, <Kbd>⇧↵</Kbd> new line, <Kbd>@</Kbd> mentions
          </span>
          <button type="button" onClick={send} disabled={!text.trim()} className="rounded-sm bg-primary px-2 py-0.5 font-medium text-primary-foreground disabled:opacity-40">
            Send
          </button>
        </div>
      </div>
    </div>
  )
}

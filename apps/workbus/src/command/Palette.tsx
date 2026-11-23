// ⌘K (design/workbus.md §9.3): go to a channel, thread, doc, or task; a new post; a new task; and
// a search across threads and docs. Text that matches no command falls back to that search: the
// operator, who takes anything else, comes in phase 2.
import { useEffect, useMemo, useState } from 'react'
import { useRouter } from '@tanstack/react-router'
import { useLiveQuery } from '@tanstack/react-db'
import { useHotkey } from '@tanstack/react-hotkeys'
import { CheckSquare, FileText, Hash, Inbox, Keyboard, LayoutGrid, MessageSquare, PenSquare, Search, UserRound } from 'lucide-react'
import { Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList } from '@/components/ui/command'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import type { Message } from '@/data/types'
import { useDocsBus } from '@/docs/bus'
import { isIssue } from '@/docs/tree'
import { Composer, type ComposerKind } from './Composer'
import { usePlaces } from './places'

const SCREENS = [
  { to: '/', label: 'Inbox', icon: Inbox },
  { to: '/my-work', label: 'My work', icon: UserRound },
  { to: '/tasks', label: 'Tasks', icon: LayoutGrid },
  { to: '/docs', label: 'Docs', icon: FileText },
]

const firstLine = (text: string) => text.split('\n').find((line) => line.trim())?.replace(/^#+\s*/, '').slice(0, 120) ?? ''

export function CommandPalette({ onCheatSheet }: { onCheatSheet?: () => void }) {
  const bus = useDocsBus()
  const places = usePlaces()
  const router = useRouter()
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const [composer, setComposer] = useState<ComposerKind | null>(null)
  const [found, setFound] = useState<{ query: string; threads: Message[] } | null>(null)

  useHotkey('Mod+K', () => setOpen((was) => !was), { meta: { name: 'Command palette', group: 'Everywhere' } })
  // The sidebar's "Search or ask" button opens it too.
  useEffect(() => {
    const show = () => setOpen(true)
    window.addEventListener('workbus:command', show)
    return () => window.removeEventListener('workbus:command', show)
  }, [])

  const { data: threads } = useLiveQuery((q) => q.from({ thread: bus.threads }))
  const { data: docs } = useLiveQuery((q) => q.from({ doc: bus.docs }))
  const { data: tasks } = useLiveQuery((q) => q.from({ task: bus.tasks }))
  const channels = useMemo(() => [...new Set([...threads.map((t) => t.channel), ...docs.map((d) => d.channel), ...tasks.map((t) => t.channel)])].filter(Boolean).sort(), [threads, docs, tasks])
  const docIds = useMemo(() => new Set(docs.map((doc) => doc.id)), [docs])
  const taskIds = useMemo(() => new Set(tasks.map((task) => task.id)), [tasks])

  // The search across threads and docs: the board's text filter, a moment after typing stops.
  useEffect(() => {
    const q = query.trim()
    if (!open || q.length < 2) return setFound(null)
    const controller = new AbortController()
    const timer = setTimeout(() => {
      bus.runtime.client
        .get<{ threads: { message: Message }[] }>('/threads?limit=20&text=' + encodeURIComponent(q), controller.signal)
        .then((page) => setFound({ query: q, threads: page.threads.map((thread) => thread.message) }))
        .catch(() => {})
    }, 200)
    return () => (clearTimeout(timer), controller.abort())
  }, [bus, open, query])

  const go = (href: string) => {
    setOpen(false)
    setQuery('')
    void router.navigate({ href })
  }
  const openThread = (message: Message) => go(docIds.has(message.id) || message.doc ? places.doc(message.id) : places.thread(message.id))
  const results = found && found.query === query.trim() ? found.threads : []

  return (
    <>
      <Dialog open={open} onOpenChange={(next) => (setOpen(next), next || setQuery(''))}>
        <DialogContent className="gap-0 overflow-hidden p-0 sm:max-w-lg">
          <DialogHeader className="border-b px-4 py-3">
            <DialogTitle className="text-sm">Search or go to</DialogTitle>
            <DialogDescription className="sr-only">Go to a screen, a channel, a doc, a task, or a thread; write something; or search</DialogDescription>
          </DialogHeader>
          <Command className="[&_[cmdk-group-heading]]:font-mono [&_[cmdk-group-heading]]:tracking-wider [&_[cmdk-group-heading]]:uppercase">
            <CommandInput autoFocus placeholder="Find a thread, a doc, or a channel…" value={query} onValueChange={setQuery} data-testid="palette-input" />
            <CommandList data-testid="palette" className="max-h-[420px]">
              <CommandEmpty>{query.trim().length < 2 ? 'Nothing matches.' : 'Searching…'}</CommandEmpty>
              <CommandGroup heading="Actions">
                <CommandItem value="make a task new task" onSelect={() => (setOpen(false), setComposer('task'))}>
                  <CheckSquare /> Make a task <span className="ml-auto shrink-0 font-mono text-xs text-muted-foreground">Action</span>
                </CommandItem>
                <CommandItem value="new post write message" onSelect={() => (setOpen(false), setComposer('post'))}>
                  <PenSquare /> New post <span className="ml-auto shrink-0 font-mono text-xs text-muted-foreground">Action</span>
                </CommandItem>
                {onCheatSheet && (
                  <CommandItem value="keyboard shortcuts cheat sheet help" onSelect={() => (setOpen(false), onCheatSheet())}>
                    <Keyboard /> Keyboard shortcuts <span className="ml-auto shrink-0 font-mono text-xs text-muted-foreground">?</span>
                  </CommandItem>
                )}
              </CommandGroup>
              {results.length > 0 && (
                <CommandGroup heading={'Search: “' + found!.query + '”'} forceMount data-testid="palette-results">
                  {results.map((message) => (
                    <CommandItem key={'found-' + message.id} value={'search ' + query + ' ' + message.id} forceMount onSelect={() => openThread(message)}>
                      {message.doc ? <FileText /> : <Search />}
                      <span className="truncate">{message.doc?.title ?? firstLine(message.text)}</span>
                      <span className="ml-auto shrink-0 font-mono text-xs text-muted-foreground">{message.doc?.path ?? '#' + message.id}</span>
                    </CommandItem>
                  ))}
                </CommandGroup>
              )}
              <CommandGroup heading="Screens">
                {SCREENS.map((screen) => (
                  <CommandItem key={'screen-' + screen.to} value={'screen ' + screen.label} onSelect={() => go(screen.to)}>
                    <screen.icon /> {screen.label} <span className="ml-auto shrink-0 font-mono text-xs text-muted-foreground">Screen</span>
                  </CommandItem>
                ))}
                {channels.map((path) => (
                  <CommandItem key={'channel-' + path} value={'channel ' + path} onSelect={() => go(places.channel(path))}>
                    <Hash /> {path} <span className="ml-auto shrink-0 font-mono text-xs text-muted-foreground">Channel</span>
                  </CommandItem>
                ))}
              </CommandGroup>
              <CommandGroup heading="Docs">
                {docs.filter((doc) => !isIssue(doc)).map((doc) => (
                  <CommandItem key={'doc-' + doc.id} value={'doc ' + doc.title + ' ' + doc.path} onSelect={() => go(places.doc(doc.id))}>
                    <FileText /> <span className="truncate">{doc.title}</span>
                    <span className="ml-auto shrink-0 font-mono text-xs text-muted-foreground">{doc.path}</span>
                  </CommandItem>
                ))}
              </CommandGroup>
              <CommandGroup heading="Tasks">
                {tasks.filter((task) => !['done', 'canceled', 'failed'].includes(task.task?.state ?? '')).map((task) => (
                  <CommandItem key={'task-' + task.id} value={'task ' + task.id + ' ' + firstLine(task.text)} onSelect={() => go(places.thread(task.id))}>
                    <CheckSquare /> <span className="truncate">{firstLine(task.text)}</span>
                    <span className="ml-auto shrink-0 font-mono text-xs text-muted-foreground">{'#' + task.id}</span>
                  </CommandItem>
                ))}
              </CommandGroup>
              <CommandGroup heading="Threads">
                {threads.filter((thread) => !docIds.has(thread.id) && !taskIds.has(thread.id)).slice(0, 200).map((thread) => (
                  <CommandItem key={'thread-' + thread.id} value={'thread ' + thread.id + ' ' + firstLine(thread.root.text)} onSelect={() => go(places.thread(thread.id))}>
                    <MessageSquare /> <span className="truncate">{firstLine(thread.root.text)}</span>
                    <span className="ml-auto shrink-0 font-mono text-xs text-muted-foreground">{'#' + thread.id}</span>
                  </CommandItem>
                ))}
              </CommandGroup>
            </CommandList>
          </Command>
          <footer className="flex items-center gap-1 border-t px-4 py-2 font-mono text-xs text-muted-foreground">
            <kbd className="rounded-sm border px-1">↑</kbd>
            <kbd className="rounded-sm border px-1">↓</kbd> navigate <kbd className="ml-2 rounded-sm border px-1">↵</kbd> open <kbd className="ml-2 rounded-sm border px-1">Esc</kbd> close
          </footer>
        </DialogContent>
      </Dialog>
      <Composer kind={composer} onClose={() => setComposer(null)} channels={channels} />
    </>
  )
}

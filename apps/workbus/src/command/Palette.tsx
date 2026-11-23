// ⌘K (design/workbus.md §9.3), drawn by the system's CommandPalette: go to a screen, channel, doc,
// task, or thread; make a task or a post; and a search across threads and docs. Text that matches no
// command falls back to that search: the operator, who takes anything else, comes in phase 2.
import { useEffect, useMemo, useState } from 'react'
import { useRouter } from '@tanstack/react-router'
import { useLiveQuery } from '@tanstack/react-db'
import { useHotkey } from '@tanstack/react-hotkeys'
import { CheckSquare, FileText, Hash, Inbox, Keyboard, LayoutGrid, MessageSquare, PenSquare, Search, UserRound } from 'lucide-react'
import { CommandPalette, type CommandPaletteItem, type TaskStateName } from '@/components/system'
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

/** The board's task states, as the design names them (blocked is held). */
const stateOf = (state: string | undefined): TaskStateName => (state === 'blocked' ? 'held' : state === 'claimed' || state === 'done' || state === 'failed' ? state : 'ready')

export function Palette({ onCheatSheet }: { onCheatSheet?: () => void }) {
  const bus = useDocsBus()
  const places = usePlaces()
  const router = useRouter()
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const [composer, setComposer] = useState<ComposerKind | null>(null)
  const [found, setFound] = useState<{ query: string; threads: Message[] } | null>(null)

  useHotkey('Mod+K', () => setOpen((was) => !was), { meta: { name: 'Command palette', group: 'Everywhere' } })
  // The sidebar's "Search or ask" opens it too.
  useEffect(() => {
    const show = () => setOpen(true)
    window.addEventListener('workbus:command', show)
    return () => window.removeEventListener('workbus:command', show)
  }, [])

  const { data: threads } = useLiveQuery({ query: (q) => q.from({ thread: bus.threads }) })
  const { data: docs } = useLiveQuery({ query: (q) => q.from({ doc: bus.docs }) })
  const { data: tasks } = useLiveQuery({ query: (q) => q.from({ task: bus.tasks }) })
  const channels = useMemo(() => [...new Set([...threads.map((t) => t.channel), ...docs.map((d) => d.channel), ...tasks.map((t) => t.channel)])].filter(Boolean).sort(), [threads, docs, tasks])

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
  const write = (kind: ComposerKind) => (setOpen(false), setQuery(''), setComposer(kind))

  const groups = useMemo(() => {
    const q = query.trim().toLowerCase()
    // cmdk's filter is off: each group is filtered here, and kept short until something is typed.
    const pick = (items: CommandPaletteItem[], cap: number) => (q ? items.filter((item) => (item.label + ' ' + (item.path ?? '')).toLowerCase().includes(q)) : items).slice(0, q ? 20 : cap)
    const docIds = new Set(docs.map((doc) => doc.id))
    const taskIds = new Set(tasks.map((task) => task.id))
    const results: CommandPaletteItem[] =
      found && found.query === query.trim()
        ? found.threads.map((message) => ({ label: message.doc?.title ?? firstLine(message.text), path: message.doc?.path ?? '#' + message.id, icon: message.doc ? FileText : Search, onSelect: () => go(message.doc || docIds.has(message.id) ? places.doc(message.id) : places.thread(message.id)) }))
        : []
    const out = [
      { name: q ? 'Search: “' + query.trim() + '”' : '', items: results },
      {
        name: 'Actions',
        items: pick(
          [
            { label: 'Make a task', path: 'action', icon: CheckSquare, onSelect: () => write('task') },
            { label: 'New post', path: 'action', icon: PenSquare, onSelect: () => write('post') },
            ...(onCheatSheet ? [{ label: 'Keyboard shortcuts', kbd: '?', icon: Keyboard, onSelect: () => (setOpen(false), onCheatSheet()) }] : []),
          ],
          3,
        ),
      },
      { name: 'Screens', items: pick([...SCREENS.map((screen) => ({ label: screen.label, path: 'screen', icon: screen.icon, onSelect: () => go(screen.to) })), ...channels.map((path) => ({ label: path, path: 'channel', icon: Hash, onSelect: () => go(places.channel(path)) }))], 8) },
      { name: 'Docs', items: pick(docs.filter((doc) => !isIssue(doc)).map((doc) => ({ label: doc.title, path: doc.path, icon: FileText, onSelect: () => go(places.doc(doc.id)) })), 5) },
      { name: 'Tasks', items: pick(tasks.filter((task) => !['done', 'canceled', 'failed'].includes(task.task?.state ?? '')).map((task) => ({ label: firstLine(task.text), path: '#' + task.id, task: stateOf(task.task?.state), onSelect: () => go(places.thread(task.id)) })), 5) },
      { name: 'Threads', items: pick(threads.filter((thread) => !docIds.has(thread.id) && !taskIds.has(thread.id)).map((thread) => ({ label: firstLine(thread.root.text), path: '#' + thread.id, icon: MessageSquare, onSelect: () => go(places.thread(thread.id)) })), 5) },
    ]
    return out.filter((group) => group.items.length > 0)
  }, [query, found, docs, tasks, threads, channels, places, onCheatSheet])

  return (
    <>
      <CommandPalette ask={false} open={open} onOpenChange={(next) => (setOpen(next), next || setQuery(''))} query={query} onQueryChange={setQuery} groups={groups} />
      <Composer kind={composer} onClose={() => setComposer(null)} channels={channels} />
    </>
  )
}

// A list's view in the URL, so a filtered list is a link: /tasks?channel=eng is #eng's queue,
// /tasks?channel=eng/ the eng team's (the channel and its subtree). Lists are comma-separated;
// state is open unless it says otherwise (state=all is every state).
import { useNavigate } from '@tanstack/react-router'
import type { ListView } from './list.tsx'
import { OPEN } from './model.ts'

export type ViewSearch = { state?: string; owner?: string; assignee?: string; channel?: string; label?: string; sort?: string; group?: string; layout?: string }

const KEYS = ['state', 'owner', 'assignee', 'channel', 'label', 'sort', 'group', 'layout'] as const

export function validateViewSearch(search: Record<string, unknown>): ViewSearch {
  const out: ViewSearch = {}
  for (const key of KEYS) if (typeof search[key] === 'string' && (search[key] as string).length <= 2000) out[key] = search[key] as string
  return out
}

const list = (value: string | undefined) => (value ? value.split(',').filter(Boolean) : [])

export function viewOf(search: ViewSearch, defaults: Partial<ListView> = {}): ListView {
  const [sortId, sortDir] = (search.sort ?? '').split(':')
  return {
    state: search.state === 'all' ? [] : search.state ? list(search.state) : (defaults.state ?? [...OPEN]),
    owner: list(search.owner),
    assignee: list(search.assignee),
    channel: list(search.channel),
    label: list(search.label),
    sort: sortId ? { id: sortId, desc: sortDir !== 'asc' } : (defaults.sort ?? { id: 'updated', desc: true }),
    group: search.group ? search.group !== 'none' : (defaults.group ?? true),
    layout: search.layout === 'board' ? 'board' : 'list',
  }
}

export function searchOf(view: ListView): ViewSearch {
  const open = view.state.length === OPEN.length && OPEN.every((state) => view.state.includes(state))
  const join = (values: string[]) => (values.length ? values.join(',') : undefined)
  return {
    state: open ? undefined : view.state.length ? view.state.join(',') : 'all',
    owner: join(view.owner),
    assignee: join(view.assignee),
    channel: join(view.channel),
    label: join(view.label),
    sort: view.sort.id === 'updated' && view.sort.desc ? undefined : view.sort.id + ':' + (view.sort.desc ? 'desc' : 'asc'),
    group: view.group ? undefined : 'none',
    layout: view.layout === 'board' ? 'board' : undefined,
  }
}

/** Writes a view into the URL, keeping the rest of the search (the open thread). */
export function useSetView() {
  const navigate = useNavigate()
  return (view: ListView) =>
    void navigate({
      to: '.',
      replace: true,
      search: (previous: Record<string, unknown>) => {
        const next: Record<string, unknown> = { ...previous }
        for (const key of KEYS) delete next[key]
        for (const [key, value] of Object.entries(searchOf(view))) if (value !== undefined) next[key] = value
        return next
      },
    })
}

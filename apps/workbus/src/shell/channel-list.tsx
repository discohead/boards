// The sidebar's unread state (design/read-state.md): a channel with unread threads is bold, and its
// mentions (its roots' and its threads') show as a count. And the new-channel flow.
import { useMemo, useState } from 'react'
import { useNavigate } from '@tanstack/react-router'
import { useLiveQuery } from '@tanstack/react-db'
import { Plus } from 'lucide-react'
import { useBus } from '@/data'

const PATH = /^[a-z0-9][a-z0-9_-]*(?:\/[a-z0-9][a-z0-9_-]*)*$/

/** Each channel's unread roots and mentions (its roots' and its threads'). */
export function useChannelCounts() {
  const bus = useBus()
  const { data } = useLiveQuery({ query: (q) => q.from({ row: bus.unread }) })
  return useMemo(() => {
    const counts = new Map<string, { unread: number; mentions: number }>()
    for (const row of data) {
      const had = counts.get(row.channel) ?? { unread: 0, mentions: 0 }
      counts.set(row.channel, { unread: had.unread + (row.kind === 'channel' ? row.unread : 0), mentions: had.mentions + row.mentions })
    }
    return counts
  }, [data])
}

/** A channel's unread state, beside its name: bold comes from the caller; this is its mention count. */
export function MentionCount({ count }: { count?: { unread: number; mentions: number } }) {
  if (!count?.mentions) return null
  return (
    <span className="ml-auto rounded-sm bg-primary px-1.5 font-mono text-[10.5px] font-semibold leading-4 tabular-nums text-primary-foreground" data-testid="mentions" aria-label={count.mentions + ' mentions'}>
      {count.mentions}
    </span>
  )
}

/** A new channel: a path, made on the board, then opened. */
export function NewChannel() {
  const bus = useBus()
  const navigate = useNavigate()
  const [open, setOpen] = useState(false)
  const [path, setPath] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const submit = async () => {
    const value = path.trim().toLowerCase()
    if (!PATH.test(value)) return setError('Lowercase letters, numbers, - and _, with / between parts.')
    setBusy(true)
    try {
      await bus.actions.createChannel(value)
      setOpen(false)
      setPath('')
      setError(null)
      void navigate({ to: '/c/$', params: { _splat: value } })
    } catch (caught) {
      setError((caught as Error).message)
    } finally {
      setBusy(false)
    }
  }
  if (!open)
    return (
      <button type="button" className="ml-auto rounded p-0.5 hover:bg-sidebar-accent hover:text-sidebar-accent-foreground" aria-label="New channel" title="New channel" onClick={() => setOpen(true)}>
        <Plus size={16} strokeWidth={1.5} />
      </button>
    )
  return (
    <form
      className="absolute left-0 right-0 top-full z-10 rounded-md border bg-popover p-2 text-popover-foreground shadow-md"
      onSubmit={(event) => {
        event.preventDefault()
        void submit()
      }}
    >
      <label className="mb-1 block text-xs font-medium text-foreground" htmlFor="new-channel">
        New channel
      </label>
      <input
        id="new-channel"
        autoFocus
        value={path}
        placeholder="eng/backend"
        onChange={(event) => setPath(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === 'Escape') setOpen(false)
        }}
        className="w-full rounded-md border bg-background px-2 py-1 text-sm text-foreground"
      />
      {error ? <p className="mt-1 text-xs text-destructive" role="alert">{error}</p> : null}
      <div className="mt-2 flex justify-end gap-2">
        <button type="button" className="rounded px-2 py-0.5 text-xs" onClick={() => setOpen(false)}>
          Cancel
        </button>
        <button type="submit" disabled={busy} className="rounded-sm bg-primary px-2 py-0.5 text-xs text-primary-foreground">
          Create channel
        </button>
      </div>
    </form>
  )
}

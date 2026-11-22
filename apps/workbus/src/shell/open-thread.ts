// The thread pane's open thread is in the URL (?thread=<id>), on whatever route is showing.
import { useNavigate, useSearch } from '@tanstack/react-router'

export function useOpenThread() {
  const thread = useSearch({ strict: false, select: (search: { thread?: number }) => search.thread })
  const navigate = useNavigate()
  return {
    thread: thread === undefined ? null : String(thread),
    open: (id: string) => void navigate({ to: '.', search: (previous: Record<string, unknown>) => ({ ...previous, thread: Number(id) }) }),
    close: () => void navigate({ to: '.', search: ({ thread: _thread, ...rest }: Record<string, unknown>) => rest }),
  }
}

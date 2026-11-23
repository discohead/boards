// The thread pane's open thread is in the URL (?thread=<id>, and its tab ?face=), on whatever route is showing.
import { useNavigate, useSearch } from '@tanstack/react-router'
import type { Face } from '../routes/__root.tsx'

export function useOpenThread() {
  const search = useSearch({ strict: false }) as { thread?: number; face?: Face }
  const navigate = useNavigate()
  return {
    thread: search.thread === undefined ? null : String(search.thread),
    face: search.face ?? null,
    open: (id: string, face?: Face) => void navigate({ to: '.', search: (previous: Record<string, unknown>) => ({ ...previous, thread: Number(id), face }) }),
    show: (face: Face) => void navigate({ to: '.', search: (previous: Record<string, unknown>) => ({ ...previous, face }) }),
    close: () => void navigate({ to: '.', search: ({ thread: _thread, face: _face, ...rest }: Record<string, unknown>) => rest }),
  }
}

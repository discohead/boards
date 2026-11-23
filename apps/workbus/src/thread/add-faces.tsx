// The faces a thread doesn't have yet, as actions in place (design/workbus.md §4.1): make it a task
// (C) without moving it, write it up (give it a body, POST /docs { re }), and assign its task (A).
// C and A are ci's shortcuts (src/command/ThreadShortcuts.tsx); these buttons call the same writes.
import { useState } from 'react'
import { FileText, SquareCheck, UserRound } from 'lucide-react'
import type { Message } from '@/data'
import { useDocsBus } from '@/docs/bus'
import { Button } from '@/components/ui/button'
import { Kbd } from '@/channel/composer'

/** A doc's slug from a thread's first line: lowercase words joined by -. */
export const slugOf = (text: string) =>
  text.split('\n')[0]!.replace(/@\[[^\]]*\]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60) || 'untitled'

export function AddFaces({ root, onFace }: { root: Message; onFace: (face: 'task' | 'doc') => void }) {
  const bus = useDocsBus()
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  if (root.task && root.doc) return null
  const settle = async (written: Promise<unknown>, face: 'task' | 'doc') => {
    setError(null)
    setBusy(true)
    try {
      await written
      onFace(face)
    } catch (refused) {
      setError(refused instanceof Error ? refused.message : String(refused))
    } finally {
      setBusy(false)
    }
  }
  return (
    <div className="mt-3 flex flex-wrap items-center gap-1.5" data-testid="add-faces">
      {root.task ? null : (
        <Button size="xs" variant="outline" disabled={busy} onClick={() => void settle(bus.threadActions.makeTask({ thread: root.id }).when('settled'), 'task')}>
          <SquareCheck size={16} strokeWidth={1.5} aria-hidden />
          Make a task <Kbd>C</Kbd>
        </Button>
      )}
      {root.doc ? null : (
        <Button size="xs" variant="outline" disabled={busy} onClick={() => void settle(bus.actions.writeUp({ re: root.id, slug: slugOf(root.text) + '-' + root.id }), 'doc')}>
          <FileText size={16} strokeWidth={1.5} aria-hidden />
          Write it up
        </Button>
      )}
      {root.task ? (
        <span className="flex items-center gap-1 text-xs text-muted-foreground">
          <UserRound size={16} strokeWidth={1.5} aria-hidden />
          Assign <Kbd>A</Kbd>
        </span>
      ) : null}
      {error ? <p role="alert" className="w-full text-xs text-destructive">{error}</p> : null}
    </div>
  )
}

// The faces a thread doesn't have yet, as add actions among its tabs (design/workbus.md §4.1, the
// design system's Tabs): make it a task (C) without moving it, and write it up (give it a body,
// POST /docs { re }). C and A are ci's shortcuts (src/command/ThreadShortcuts.tsx); these call the
// same writes.
import { useState } from 'react'
import { BusRefusal, type Message } from '@/data'
import { useDocsBus } from '@/docs/bus'

/** A doc's slug from a thread's first line: lowercase words joined by -. */
export const slugOf = (text: string) =>
  text.split('\n')[0]!.replace(/@\[[^\]]*\]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60) || 'untitled'

type AddTab = { id: string; label: string; add: true; onAdd: () => void }

/** The add tabs for the faces root lacks, and what went wrong adding one. */
export function useAddFaces(root: Message | undefined, onFace: (face: 'task' | 'doc') => void): { tabs: AddTab[]; error: string | null } {
  const bus = useDocsBus()
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  if (!root) return { tabs: [], error }
  const settle = async (written: () => Promise<unknown>, face: 'task' | 'doc') => {
    if (busy) return
    setError(null)
    setBusy(true)
    try {
      await written()
      onFace(face)
    } catch (refused) {
      setError(refused instanceof Error ? refused.message : String(refused))
    } finally {
      setBusy(false)
    }
  }
  /** The slug from its first line; if a doc there has it already, the same with its cursor. */
  const writeUp = () =>
    bus.actions.writeUp({ re: root.id, slug: slugOf(root.text) }).catch((refused: unknown) => {
      if (refused instanceof BusRefusal && refused.code === 'slug_taken') return bus.actions.writeUp({ re: root.id, slug: slugOf(root.text) + '-' + root.id })
      throw refused
    })
  const tabs: AddTab[] = []
  if (!root.task) tabs.push({ id: 'add-task', label: 'Make a task', add: true, onAdd: () => void settle(() => bus.threadActions.makeTask({ thread: root.id }).when('settled'), 'task') })
  if (!root.doc) tabs.push({ id: 'add-doc', label: 'Write it up', add: true, onAdd: () => void settle(writeUp, 'doc') })
  return { tabs, error }
}

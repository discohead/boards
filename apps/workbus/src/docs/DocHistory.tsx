// A doc's history: each edit (who, when, which sections), and for one, what it changed, section by
// section, as a line diff. Read from the board when opened (GET /docs/:id/history and /diff).
import { useEffect, useState } from 'react'
import { cn } from '@/lib/utils'
import { useDocsBus } from './bus'
import { lineDiff } from './linediff'

type Edit = { revision: string; kind: 'created' | 'edited'; at: string; by: { actor: string } | null; base?: string | null; sections?: { section: string; op: string }[] }
type Change = { section: string; change: 'inserted' | 'edited' | 'removed'; before?: string; after?: string }

export function DocHistory({ id }: { id: string }) {
  const bus = useDocsBus()
  const [edits, setEdits] = useState<Edit[] | null>(null)
  const [open, setOpen] = useState<string | null>(null)
  const [changes, setChanges] = useState<Change[] | null>(null)
  const revision = bus.bodies.utils.rows.get(id)?.revision
  useEffect(() => {
    bus.runtime.client.get<{ edits: Edit[] }>('/docs/' + id + '/history?limit=100').then((page) => setEdits(page.edits.reverse()))
  }, [bus, id, revision])
  const show = (edit: Edit) => {
    setOpen(edit.revision)
    setChanges(null)
    const from = edit.base && /^\d+$/.test(edit.base) ? edit.base : String(Number(edit.revision) - 1)
    bus.runtime.client.get<{ sections: Change[] }>('/docs/' + id + '/diff?from=' + from + '&to=' + edit.revision).then((page) => setChanges(page.sections))
  }
  if (!edits) return <p className="mb-6 text-sm text-muted-foreground">Loading history…</p>
  return (
    <section className="mb-8 rounded-lg border p-4 text-sm" data-testid="doc-history">
      <ol className="space-y-1">
        {edits.map((edit) => (
          <li key={edit.revision}>
            <button type="button" disabled={edit.kind === 'created'} onClick={() => show(edit)} className={cn('w-full rounded px-2 py-1 text-left hover:bg-muted disabled:hover:bg-transparent', open === edit.revision && 'bg-muted')}>
              <span className="font-mono text-xs">r{edit.revision}</span> {edit.kind === 'created' ? 'created' : 'edited ' + (edit.sections ?? []).map((s) => s.section || 'the introduction').join(', ')} · {(edit.by && bus.actors.get(edit.by.actor)?.name) ?? edit.by?.actor ?? 'someone'} · {new Date(edit.at).toLocaleString()}
            </button>
          </li>
        ))}
      </ol>
      {open && (
        <div className="mt-4 space-y-4" data-testid="doc-diff">
          {changes === null && <p className="text-muted-foreground">Loading the change…</p>}
          {changes?.map((change) => (
            <div key={change.section}>
              <p className="mb-1 font-mono text-xs text-muted-foreground">
                {change.section || '(introduction)'} · {change.change}
              </p>
              <pre className="overflow-x-auto rounded-md border bg-muted/40 p-2 text-xs leading-5">
                {lineDiff(change.before ?? '', change.after ?? '').map((line, index) => (
                  <div key={index} className={cn(line.kind === 'added' && 'bg-green-500/15 text-green-800 dark:text-green-300', line.kind === 'removed' && 'bg-red-500/15 text-red-800 line-through dark:text-red-300')}>
                    {line.kind === 'added' ? '+ ' : line.kind === 'removed' ? '- ' : '  '}
                    {line.text}
                  </div>
                ))}
              </pre>
            </div>
          ))}
        </div>
      )}
    </section>
  )
}

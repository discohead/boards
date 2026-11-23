// Docs (design/workbus.md §9.3): every doc in a list, newest change first, filtered by its top
// folder; a doc opens in the thread pane, on its Document face.
import { useMemo, useState } from 'react'
import { createFileRoute } from '@tanstack/react-router'
import { useLiveQuery } from '@tanstack/react-db'
import { ChevronRight, FileText, Plus } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { ListPane, type Chip } from '@/shell/list-pane'
import { useOpenThread } from '@/shell/open-thread'
import { useDocsBus } from '@/docs/bus'
import { isIssue } from '@/docs/tree'
import { NewDoc } from '@/docs/NewDoc'
import { cn } from '@/lib/utils'

export const Route = createFileRoute('/docs')({ component: Docs })

const top = (path: string) => path.split('/')[0]! + '/'

function Docs() {
  const bus = useDocsBus()
  const { thread, open } = useOpenThread()
  const { data } = useLiveQuery({ query: (q) => q.from({ doc: bus.docs }) })
  const docs = useMemo(() => data.filter((doc) => !isIssue(doc)).sort((a, b) => Number(b.revision) - Number(a.revision)), [data])
  const [folder, setFolder] = useState<string | null>(null)
  const [making, setMaking] = useState(false)
  const folders = useMemo(() => [...new Set(docs.map((doc) => top(doc.path)))].sort(), [docs])
  const chips: Chip[] = [{ label: 'All', active: folder === null, onClick: () => setFolder(null) }, ...folders.map((name) => ({ label: name, active: folder === name, onClick: () => setFolder(name) }))]
  const shown = folder ? docs.filter((doc) => top(doc.path) === folder) : docs
  return (
    <ListPane
      title="Docs"
      chips={chips}
      actions={
        <Button size="sm" onClick={() => setMaking(true)}>
          <Plus className="size-4" /> New document
        </Button>
      }
    >
      {shown.length === 0 ? <p className="px-4 py-3 text-sm text-muted-foreground">No documents yet.</p> : null}
      <ul data-testid="doc-list">
        {shown.map((doc) => (
          <li key={doc.id} data-id={doc.id} data-path={doc.path}>
            <button type="button" onClick={() => open(doc.id, 'doc')} aria-current={thread === doc.id ? 'true' : undefined} className={cn('flex w-full items-center gap-3 border-b px-4 py-3 text-left hover:bg-accent', thread === doc.id && 'bg-accent')}>
              <FileText className="size-4 shrink-0 text-muted-foreground" />
              <span className="min-w-0 flex-1">
                <span className="block truncate text-sm font-medium">{doc.title}</span>
                <span className="block truncate font-mono text-xs text-muted-foreground">
                  {doc.path} · revision {doc.revision}
                </span>
              </span>
              <span className="font-mono text-xs text-muted-foreground">#{doc.id}</span>
              <ChevronRight className="size-4 text-muted-foreground" />
            </button>
          </li>
        ))}
      </ul>
      <NewDoc open={making} onClose={() => setMaking(false)} onMade={(id) => open(id, 'doc')} />
    </ListPane>
  )
}

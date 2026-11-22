// The docs tree in the sidebar or the docs page: folders open and close; the open doc is marked and
// its folders are open.
import { useMemo, useState } from 'react'
import { Link } from '@tanstack/react-router'
import { useLiveQuery } from '@tanstack/react-db'
import { ChevronRight, FileText, Folder } from 'lucide-react'
import { cn } from '@/lib/utils'
import { useDocsBus } from './bus'
import { ancestors, buildTree, label, type TreeNode } from './tree'

export function DocsTree({ current }: { current?: string }) {
  const bus = useDocsBus()
  const { data: docs } = useLiveQuery((q) => q.from({ doc: bus.docs }))
  const tree = useMemo(() => buildTree(docs), [docs])
  const currentPath = docs.find((doc) => doc.id === current)?.path
  const [open, setOpen] = useState<Set<string>>(() => new Set())
  const isOpen = (path: string) => open.has(path) || (currentPath !== undefined && ancestors(currentPath).includes(path))
  const toggle = (path: string) =>
    setOpen((had) => {
      const next = new Set(had)
      if (isOpen(path)) next.delete(path)
      else next.add(path)
      return next
    })
  if (tree.length === 0) return <p className="px-2 py-1 text-sm text-muted-foreground">No docs yet.</p>
  return (
    <ul role="tree" aria-label="Docs" className="text-sm" data-testid="docs-tree">
      {tree.map((node) => (
        <Branch key={node.path} node={node} depth={0} current={current} isOpen={isOpen} toggle={toggle} />
      ))}
    </ul>
  )
}

function Branch({ node, depth, current, isOpen, toggle }: { node: TreeNode; depth: number; current?: string; isOpen: (path: string) => boolean; toggle: (path: string) => void }) {
  const folder = node.children.length > 0
  const opened = folder && isOpen(node.path)
  const active = node.doc !== null && node.doc.id === current
  return (
    <li role="treeitem" aria-expanded={folder ? opened : undefined} aria-selected={active} data-path={node.path}>
      <div className={cn('group flex items-center gap-1 rounded-md pr-2 hover:bg-sidebar-accent', active && 'bg-sidebar-accent font-medium')} style={{ paddingLeft: 4 + depth * 14 }}>
        {folder ? (
          <button type="button" onClick={() => toggle(node.path)} aria-label={(opened ? 'Close ' : 'Open ') + label(node)} className="rounded p-0.5 text-muted-foreground hover:text-foreground">
            <ChevronRight className={cn('size-3.5 transition-transform', opened && 'rotate-90')} />
          </button>
        ) : (
          <span className="w-[18px]" />
        )}
        {node.doc ? (
          <Link to="/docs/$id" params={{ id: node.doc.id }} className="flex min-w-0 flex-1 items-center gap-1.5 py-1">
            <FileText className="size-3.5 shrink-0 text-muted-foreground" />
            <span className="truncate">{label(node)}</span>
          </Link>
        ) : (
          <button type="button" onClick={() => toggle(node.path)} className="flex min-w-0 flex-1 items-center gap-1.5 py-1 text-left">
            <Folder className="size-3.5 shrink-0 text-muted-foreground" />
            <span className="truncate">{node.name}</span>
          </button>
        )}
      </div>
      {opened && (
        <ul role="group">
          {node.children.map((child) => (
            <Branch key={child.path} node={child} depth={depth + 1} current={current} isOpen={isOpen} toggle={toggle} />
          ))}
        </ul>
      )}
    </li>
  )
}

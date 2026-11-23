// The docs: the tree beside the open doc (design/workbus.md §9.3), in the frame's main area.
import { Outlet, createFileRoute, useRouterState } from '@tanstack/react-router'
import { DocsTree } from '@/docs/DocsTree'

export const Route = createFileRoute('/docs')({ component: Docs })

function Docs() {
  const pathname = useRouterState({ select: (state) => state.location.pathname })
  return (
    <div className="flex min-h-full">
      <nav aria-label="Docs" className="w-60 shrink-0 border-r p-2">
        <div className="px-2 py-2 text-sm font-semibold">Docs</div>
        <DocsTree current={/^\/docs\/([^/]+)/.exec(pathname)?.[1]} />
      </nav>
      <div className="min-w-0 flex-1">
        <Outlet />
      </div>
    </div>
  )
}

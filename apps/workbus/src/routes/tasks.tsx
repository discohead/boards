// Task lists and boards by state (Table). A stub for the task views' owner.
import { createFileRoute } from '@tanstack/react-router'
import { ListPane } from '@/shell/list-pane'

export const Route = createFileRoute('/tasks')({ component: Tasks })

function Tasks() {
  return (
    <ListPane title="Tasks">
      <p className="px-4 py-3 text-sm text-muted-foreground">Not built yet.</p>
    </ListPane>
  )
}

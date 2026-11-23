// My work: the principal's tasks and follows. A stub for the task views' owner.
import { createFileRoute } from '@tanstack/react-router'
import { ListPane } from '@/shell/list-pane'

export const Route = createFileRoute('/my-work')({ component: MyWork })

function MyWork() {
  return (
    <ListPane title="My work">
      <p className="px-4 py-3 text-sm text-muted-foreground">Not built yet.</p>
    </ListPane>
  )
}

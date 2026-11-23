// Settings: org, access, sync, budgets. Later.
import { createFileRoute } from '@tanstack/react-router'
import { ListPane } from '@/shell/list-pane'

export const Route = createFileRoute('/settings')({ component: Settings })

function Settings() {
  return (
    <ListPane title="Settings">
      <p className="px-4 py-3 text-sm text-muted-foreground">Not built yet.</p>
    </ListPane>
  )
}

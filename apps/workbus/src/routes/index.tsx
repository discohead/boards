// The inbox (design/workbus.md §6): what needs the principal. A stub for the inbox's owner.
import { createFileRoute } from '@tanstack/react-router'
import { ListPane } from '@/shell/list-pane'

export const Route = createFileRoute('/')({ component: Inbox })

function Inbox() {
  return (
    <ListPane title="Inbox">
      <p className="px-4 py-3 text-sm text-muted-foreground">Not built yet.</p>
    </ListPane>
  )
}

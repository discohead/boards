// The inbox (design/workbus.md §6): what needs the principal. A stub for the inbox's owner.
import { createFileRoute } from '@tanstack/react-router'

export const Route = createFileRoute('/')({ component: Inbox })

function Inbox() {
  return (
    <div className="p-8">
      <h1 className="text-lg font-semibold">Inbox</h1>
      <p className="mt-2 text-sm text-muted-foreground">Not built yet.</p>
    </div>
  )
}

// Task lists and boards by state (Table). A stub for the task views' owner.
import { createFileRoute } from '@tanstack/react-router'

export const Route = createFileRoute('/tasks')({ component: Tasks })

function Tasks() {
  return (
    <div className="p-8">
      <h1 className="text-lg font-semibold">Tasks</h1>
      <p className="mt-2 text-sm text-muted-foreground">Not built yet.</p>
    </div>
  )
}

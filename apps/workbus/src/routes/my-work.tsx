// My work: the principal's tasks and follows. A stub for the task views' owner.
import { createFileRoute } from '@tanstack/react-router'

export const Route = createFileRoute('/my-work')({ component: MyWork })

function MyWork() {
  return (
    <div className="p-8">
      <h1 className="text-lg font-semibold">My Work</h1>
      <p className="mt-2 text-sm text-muted-foreground">Not built yet.</p>
    </div>
  )
}

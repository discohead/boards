// The thread pane's status face, for a task: its state, owner, and claim. A stub for the task views' owner.
import type { Message } from '@/data'

export function Status({ root }: { root: Message }) {
  const task = root.task!
  return (
    <section aria-label="Status" data-testid="status" className="border-b p-4 text-sm">
      <span className="rounded-md bg-secondary px-2 py-0.5">{task.state}</span>
      {task.claim ? <span className="ml-2 text-muted-foreground">claimed by {task.claim.actor}</span> : null}
    </section>
  )
}

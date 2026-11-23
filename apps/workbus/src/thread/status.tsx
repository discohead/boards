// The thread pane's status face, for a task: its state, owner, and claim. A stub for the task views' owner.
import { taskState, type Message } from '@/data'

export function Status({ root }: { root: Message }) {
  const task = root.task!
  const shown = taskState(task)
  return (
    <section aria-label="Status" data-testid="status" className="border-b p-4 text-sm">
      <span data-state={shown.state} className="rounded-sm bg-secondary px-2 py-0.5">{shown.word}</span>
      {task.claim ? <span className="ml-2 text-muted-foreground">claimed by <span className="font-mono">{task.claim.actor}</span></span> : null}
    </section>
  )
}

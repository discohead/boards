// The thread pane's status face, for a task: its state, its claim, and its actions (the shared
// TaskActionBar). A stub for threads' Task face, which keeps the action bar.
import { taskState, type Message } from '@/data'
import { TaskActionBar } from '@/task/actions'
import { holdOf, type Task } from '@/task/model'

export function Status({ root }: { root: Message }) {
  const task = root as Task
  const shown = taskState(task.task)
  const hold = holdOf(task)
  return (
    <section aria-label="Status" data-testid="status" className="flex flex-col gap-2 border-b p-4 text-sm">
      <div>
        <span data-state={shown.state} className="rounded-sm bg-secondary px-2 py-0.5">{shown.word}</span>
        {hold ? <span className="ml-2 text-muted-foreground"><span className="font-mono text-xs">{hold.kind ?? 'held'}</span> {hold.reason}</span> : null}
        {task.task.claim ? <span className="ml-2 text-muted-foreground">claimed by <span className="font-mono">{task.task.claim.actor}</span></span> : null}
      </div>
      <TaskActionBar task={task} />
    </section>
  )
}

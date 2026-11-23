// The thread pane's Task face (design/workbus.md §4.1): its state, who owns it and who works it, its
// claim, what it needs, and what holds it, then the actions that apply now (work's TaskActionBar,
// the same buttons the lists show). Needs are threads: each links to its own, and can be added or
// taken away here.
import { useState } from 'react'
import { X } from 'lucide-react'
import { taskState, useBus, type Message } from '@/data'
import { TaskActionBar } from '@/task/actions'
import { holdLabel, holdOf, type Task } from '@/task/model'
import { useOpenThread } from '@/shell/open-thread'
import { Clock } from '@/shell/clock'
import { handleOf } from '@/thread/mentions'

export function Status({ root }: { root: Message }) {
  const bus = useBus()
  const { open } = useOpenThread()
  const task = root as Task
  const facet = task.task
  const shown = taskState(facet)
  const hold = holdOf(task)
  const who = (actor: string | null) => (actor ? '@' + handleOf(bus.actors, actor) : 'no one')
  const [adding, setAdding] = useState('')
  const [error, setError] = useState<string | null>(null)
  const setNeeds = async (needs: string[]) => {
    setError(null)
    try {
      await bus.actions.task.needs({ id: task.id, needs }).when('settled')
    } catch (refused) {
      setError(refused instanceof Error ? refused.message : String(refused))
    }
  }
  const fact = 'grid grid-cols-[6rem_1fr] items-baseline gap-2'
  return (
    <section aria-label="Task" data-testid="status" className="flex flex-col gap-3 overflow-y-auto px-6 py-4 text-sm">
      {hold ? (
        <div data-testid="hold" className="rounded-md bg-primary/10 px-3 py-2 text-primary">
          <span className="font-mono text-xs">{holdLabel(hold.kind)}</span> {hold.reason}
        </div>
      ) : null}
      <dl className="flex flex-col gap-1.5">
        <div className={fact}>
          <dt className="text-muted-foreground">State</dt>
          <dd data-testid="task-state" data-state={shown.state}>
            {shown.word}
            {shown.waitsOn?.length ? <span className="text-muted-foreground"> on what it needs</span> : null}
          </dd>
        </div>
        <div className={fact}>
          <dt className="text-muted-foreground">Owner</dt>
          <dd className="font-mono text-xs" data-testid="task-owner">{who(facet.owner)}</dd>
        </div>
        <div className={fact}>
          <dt className="text-muted-foreground">Assigned to</dt>
          <dd className="font-mono text-xs" data-testid="task-for">{facet.for ? who(facet.for) : 'anyone'}</dd>
        </div>
        {facet.claim ? (
          <div className={fact}>
            <dt className="text-muted-foreground">Claimed by</dt>
            <dd className="font-mono text-xs" data-testid="task-claim">
              {who(facet.claim.actor)} <span className="text-muted-foreground">until <Clock at={facet.claim.until} /></span>
            </dd>
          </div>
        ) : null}
        <div className={fact}>
          <dt className="text-muted-foreground">Needs</dt>
          <dd className="flex flex-wrap items-center gap-1.5" data-testid="task-needs">
            {facet.needs.map((need) => (
              <span key={need} className="flex items-center rounded-sm border font-mono text-xs">
                <button type="button" className="px-1.5 hover:underline" onClick={() => open(need)}>
                  #{need} {bus.tasks.get(need)?.task ? <span className="text-muted-foreground">{taskState(bus.tasks.get(need)!.task!).word}</span> : null}
                </button>
                {facet.claim ? null : <button type="button" aria-label={'No longer needs #' + need} className="border-l px-1 text-muted-foreground hover:text-foreground" onClick={() => void setNeeds(facet.needs.filter((one) => one !== need))}>
                  <X size={12} strokeWidth={1.5} />
                </button>}
              </span>
            ))}
            {facet.claim ? (
              facet.needs.length ? null : <span className="text-muted-foreground">nothing</span>
            ) : (
            <form
              onSubmit={(event) => {
                event.preventDefault()
                const id = adding.replace(/^#/, '').trim()
                if (!/^\d+$/.test(id) || facet.needs.includes(id)) return
                setAdding('')
                void setNeeds([...facet.needs, id])
              }}
            >
              <input aria-label="Add a need" placeholder="#cursor" value={adding} onChange={(event) => setAdding(event.target.value)} className="h-6 w-20 rounded-sm border bg-background px-1.5 font-mono text-xs" />
            </form>
            )}
          </dd>
        </div>
        {facet.result ? (
          <div className={fact}>
            <dt className="text-muted-foreground">Result</dt>
            <dd>{String(facet.result)}</dd>
          </div>
        ) : null}
        {facet.reason && !hold ? (
          <div className={fact}>
            <dt className="text-muted-foreground">Reason</dt>
            <dd>{facet.reason}</dd>
          </div>
        ) : null}
      </dl>
      {error ? <p role="alert" className="text-xs text-destructive">{error}</p> : null}
      <TaskActionBar task={task} />
    </section>
  )
}

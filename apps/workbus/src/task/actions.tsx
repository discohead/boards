// A task's actions, as buttons: the ones that apply to it now, for me (model.ts actionsFor), each a
// write from bus.actions.task. The thread pane's Task face, the inbox, and the lists all use this.
// Holding asks for a reason and a kind; canceling and failing ask for a reason; assigning picks one
// of the seats, the principal, or the owner's profiles (task/assignable.ts), or anyone.
import { useState } from 'react'
import { useBus } from '@/data'
import { Button } from '@/components/ui/button'
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuTrigger } from '@/components/ui/dropdown-menu'
import { ACTION_LABEL, actionsFor, can, proposalOf, type Task, type TaskAction } from './model.ts'
import { useMe } from './me.ts'
import { useAssignable } from './assignable.ts'

const KINDS = ['decision', 'approval', 'review', 'budget'] as const

/** What a proposal's complete and cancel say: the change is applied, or dropped. */
const PROPOSAL_LABEL: Partial<Record<TaskAction, string>> = { complete: 'Apply', cancel: 'Drop' }

export function TaskActionBar({ task, onDone }: { task: Task; onDone?: (action: TaskAction) => void }) {
  const bus = useBus()
  const me = useMe()
  const [asking, setAsking] = useState<null | 'block' | 'cancel' | 'fail'>(null)
  const [reason, setReason] = useState('')
  const [kind, setKind] = useState<string>('decision')
  const [error, setError] = useState<string | null>(null)
  const assignable = useAssignable(task.task.owner, me?.actor)
  if (!me) return null
  const proposal = proposalOf(task) !== null
  const actions = actionsFor(task, me.actor, can(me.can, 'manage', task.channel)).filter((action) => !(proposal && (action === 'claim' || action === 'block' || action === 'assign')))
  const w = bus.actions.task
  const run = async (action: TaskAction, transaction: { when: (state: 'settled') => Promise<unknown> }) => {
    setError(null)
    onDone?.(action)
    try {
      await transaction.when('settled')
    } catch (refused) {
      setError(refused instanceof Error ? refused.message : String(refused))
    }
  }
  const go = (action: TaskAction) => {
    const id = task.id
    if (action === 'block' || action === 'cancel' || action === 'fail') return setAsking(action)
    if (action === 'claim') return run(action, w.claim({ id }))
    if (action === 'release') return run(action, w.release({ id }))
    if (action === 'complete') return run(action, w.complete({ id }))
    if (action === 'unblock') return run(action, w.unblock({ id }))
    if (action === 'reopen') return run(action, w.reopen({ id }))
  }
  const submit = () => {
    if (!reason.trim() || !asking) return
    const id = task.id
    const action = asking
    setAsking(null)
    setReason('')
    if (action === 'block') return run(action, w.block({ id, reason: reason.trim(), kind }))
    if (action === 'cancel') return run(action, w.cancel({ id, reason: reason.trim() }))
    return run(action, w.fail({ id, reason: reason.trim() }))
  }
  // The view's one primary action: answering what's held (Unblock), applying a proposal, or completing.
  const primary: TaskAction | undefined = actions.find((action) => action === 'unblock') ?? actions.find((action) => action === 'complete')
  return (
    <div className="flex flex-col gap-2" data-testid="task-actions">
      <div className="flex flex-wrap items-center gap-1.5">
        {actions.map((action) =>
          action === 'assign' ? (
            <DropdownMenu key={action}>
              <DropdownMenuTrigger asChild>
                <Button variant="outline" size="xs">Assign</Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="start">
                <DropdownMenuLabel className="text-xs text-muted-foreground">Who may claim it</DropdownMenuLabel>
                <DropdownMenuItem onSelect={() => run('assign', w.assign({ id: task.id, for: null }))}>Anyone</DropdownMenuItem>
                {assignable.length ? <DropdownMenuSeparator /> : null}
                {assignable.map((one) => (
                  <DropdownMenuItem key={one.id} data-assignee={one.id} onSelect={() => run('assign', w.assign({ id: task.id, for: one.id }))}>
                    {one.name} <span className="ml-auto font-mono text-xs text-muted-foreground">@{one.handle}</span>
                  </DropdownMenuItem>
                ))}
              </DropdownMenuContent>
            </DropdownMenu>
          ) : (
            <Button key={action} size="xs" variant={action === primary ? 'default' : 'outline'} onClick={() => go(action)}>
              {(proposal && PROPOSAL_LABEL[action]) || ACTION_LABEL[action]}
            </Button>
          ),
        )}
      </div>
      {asking ? (
        <form
          className="flex flex-wrap items-center gap-1.5"
          onSubmit={(event) => {
            event.preventDefault()
            submit()
          }}
        >
          {asking === 'block' ? (
            <select aria-label="Kind" value={kind} onChange={(event) => setKind(event.target.value)} className="h-6 rounded-sm border bg-background px-1 font-mono text-xs">
              {KINDS.map((one) => (
                <option key={one} value={one}>
                  {one}
                </option>
              ))}
            </select>
          ) : null}
          <input autoFocus aria-label="Reason" placeholder={asking === 'block' ? 'What it needs from you' : 'Why'} value={reason} onChange={(event) => setReason(event.target.value)} className="h-6 min-w-48 flex-1 rounded-sm border bg-background px-2 text-xs" />
          <Button size="xs" type="submit" disabled={!reason.trim()}>
            {asking === 'block' ? 'Hold' : asking === 'cancel' ? (proposal ? 'Drop' : 'Cancel task') : 'Fail'}
          </Button>
          <Button size="xs" variant="ghost" type="button" onClick={() => setAsking(null)}>
            Never mind
          </Button>
        </form>
      ) : null}
      {error ? (
        <p role="alert" className="text-xs text-destructive">
          {error}
        </p>
      ) : null}
    </div>
  )
}

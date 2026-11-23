// A task held for an approval (design/workbus.md §6.2), as the system's ApprovalCard at the top of
// its thread: who wants to run what, Approve (⌘↵) and Decline. Either answer gives the task back to
// the seat that held it, with the decision on the task (design/cross-principal-tasks.md), which wakes
// its parked session. In the inbox, ⌘↵ is the inbox's own (its selected item), so here it's off there.
import { useLocation } from '@tanstack/react-router'
import { useHotkey } from '@tanstack/react-hotkeys'
import { ApprovalCard, toast } from '@/components/system'
import { useBus, type Message } from '@/data'
import { named, summaryOf } from '@/data/text'
import { useActorNames } from '@/task/actors'
import { holdLabel, holdOf, isTask } from '@/task/model'
import { refreshSeats, useSeats } from '@/seats/use-seats'

/** "Approve or deny exec for @ada" (seats/session.ts): the tool, and the seat's handle. */
export function askOf(reason: string): { tool: string; handle: string } | null {
  const found = /^Approve or deny (\S+) for @([a-z0-9-]+)/.exec(reason)
  return found ? { tool: found[1]!, handle: found[2]! } : null
}

/** What the held call would run, from the approval task's text (seats/session.ts): its thread, and its input, shortened. */
export function callOf(text: string): { thread: string | null; input: string | null } {
  const thread = /asks to run \S+ in #(\d+)/.exec(text)?.[1] ?? null
  const block = /```json\n([\s\S]*?)\n```/.exec(text)?.[1]
  let input: string | null = null
  if (block)
    try {
      const value = JSON.parse(block) as Record<string, unknown>
      const first = Object.values(value).find((one) => typeof one === 'string') as string | undefined
      input = (first ?? JSON.stringify(value)).replace(/\s+/g, ' ').trim()
      if (input.length > 140) input = input.slice(0, 139) + '…'
    } catch {}
  return { thread, input }
}

export function useAnswer() {
  const bus = useBus()
  return (task: Message, decision: 'approved' | 'declined', note?: string) => {
    const tx = bus.actions.task.unblock({ id: task.id, decision, ...(note ? { note } : {}) })
    tx.when('settled').then(
      () => {
        refreshSeats()
        toast({ children: decision === 'approved' ? 'Approved.' : 'Declined.', cursor: '#' + task.id })
      },
      (error: Error) => toast({ children: 'Not answered: ' + error.message, cursor: '#' + task.id, tone: 'danger' }),
    )
  }
}

export function Approval({ root }: { root: Message }) {
  const pathname = useLocation({ select: (location) => location.pathname })
  const { seats } = useSeats()
  const answer = useAnswer()
  const name = useActorNames()
  const hold = isTask(root) ? holdOf(root) : null
  const held = !!hold && hold.kind === 'approval'
  useHotkey('Mod+Enter', () => answer(root, 'approved'), { enabled: held && pathname !== '/', meta: { name: 'Approve', group: 'Thread' } })
  if (!held) return null
  const ask = askOf(hold.reason)
  const seat = seats.find((one) => (ask ? one.handle === ask.handle : one.holds.some((h) => h.task === root.id)))
  const who = seat?.name ?? (ask ? '@' + ask.handle : 'A seat')
  const title = ask ? who + ' wants to run ' + ask.tool + '.' : hold.reason
  return (
    <div data-testid="approval" data-task={root.id} className="px-6 pb-3">
      <ApprovalCard
        eyebrow={holdLabel(hold.kind)}
        title={title}
        reason={reasonOf(root.text, ask !== null, summaryOf(root.text, named(name)))}
        onApprove={() => answer(root, 'approved')}
        onDecline={() => answer(root, 'declined')}
      />
    </div>
  )
}

/** In #91: <its input>. Then what each answer does. */
function reasonOf(text: string, asked: boolean, summary: string) {
  const call = callOf(text)
  const what = asked && (call.thread || call.input) ? 'In #' + (call.thread ?? '?') + (call.input ? ': ' + call.input : '') + '. ' : summary ? summary.replace(/[.:]$/, '') + '. ' : ''
  return what + 'Approving resumes the paused run; declining hands it back without that step.'
}

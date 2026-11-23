// A proposal (board.doc.proposal) at the top of its thread, and in the Task face: what applying it
// will do in plain words (task/proposal.ts), and one pair of actions, Apply and Decline (with an
// optional reason). Apply completes it as its owner would, without a claim, so a refusal leaves
// nothing held; once applied it says so and links to what it made or changed. Never Claim.
import { useEffect, useState } from 'react'
import { Link, useLocation } from '@tanstack/react-router'
import { useLiveQuery } from '@tanstack/react-db'
import { useHotkey } from '@tanstack/react-hotkeys'
import { ApprovalCard, Button, toast } from '@/components/system'
import { useBus, type Message } from '@/data'
import { describe, type Preview, type Proposal } from '@/task/proposal'
import { isTask, proposalOf, stateOf } from '@/task/model'
import { refreshSeats } from '@/seats/use-seats'

const EYEBROW: Record<Proposal['kind'], string> = { hire: 'A hire to apply', team: 'A change to the org', seat: 'A change to a seat', org: 'A change to the org', doc: 'A proposed doc change' }

/** The board's view of a change to an existing doc: the body it would have. Null until it answers, or when it can't. */
export function usePreview(task: Message | null): Preview | null {
  const bus = useBus()
  const [preview, setPreview] = useState<Preview | null>(null)
  const label = task ? proposalOf(task) : null
  useEffect(() => {
    if (!task || !label || label.startsWith('new:')) return
    let live = true
    bus.runtime.client.get<Preview>('/docs/proposals/' + task.id).then((answer) => live && setPreview(answer), () => {})
    return () => void (live = false)
  }, [bus, task?.id, label])
  return preview
}

/** Apply and Decline, as the inbox, the pane, and the task face all use them. */
export function useProposalActions() {
  const bus = useBus()
  const apply = (task: Message, proposal: Proposal | null) => {
    const tx = bus.actions.task.apply({ id: task.id })
    tx.when('settled').then(
      () => {
        refreshSeats()
        toast({ children: 'Applied: ' + (proposal?.title ?? 'the proposal') + '.', cursor: '#' + task.id })
      },
      (error: Error) => toast({ children: "Couldn't apply it: " + error.message, cursor: '#' + task.id, tone: 'danger' }),
    )
  }
  const decline = (task: Message, reason?: string) => {
    const tx = bus.actions.task.decline({ id: task.id, ...(reason ? { reason } : {}) })
    tx.when('settled').then(
      () => toast({ children: 'Declined.', cursor: '#' + task.id }),
      (error: Error) => toast({ children: "Couldn't decline it: " + error.message, cursor: '#' + task.id, tone: 'danger' }),
    )
  }
  return { apply, decline }
}

/** Where what it made or changed is. */
export function ResultLink({ proposal }: { proposal: Proposal }) {
  const bus = useBus()
  const { data: docs } = useLiveQuery({ query: (q) => q.from({ doc: bus.docs }) })
  if (proposal.link.to === 'seat')
    return (
      <Link to="/seats/$key" params={{ key: proposal.link.key }} data-testid="proposal-result-link" className="font-mono text-mono-ui text-text underline">
        {proposal.path}
      </Link>
    )
  const path = proposal.link.path
  const doc = docs.find((one) => one.path === path)
  return doc ? (
    <Link to="/docs/$id" params={{ id: doc.id }} data-testid="proposal-result-link" className="font-mono text-mono-ui text-text underline">
      {path}
    </Link>
  ) : (
    <span data-testid="proposal-result-link" className="font-mono text-mono-ui">{path}</span>
  )
}

export function ProposalCard({ root }: { root: Message }) {
  const pathname = useLocation({ select: (location) => location.pathname })
  const preview = usePreview(root)
  const proposal = describe(root, preview)
  const { apply, decline } = useProposalActions()
  const [declining, setDeclining] = useState(false)
  const [reason, setReason] = useState('')
  const open = isTask(root) && ['ready', 'waiting', 'claimed', 'blocked'].includes(stateOf(root))
  useHotkey('Mod+Enter', () => apply(root, proposal), { enabled: !!proposal && open && pathname !== '/', meta: { name: 'Apply the proposal', group: 'Thread' } })
  if (!proposal || !isTask(root)) return null
  const state = stateOf(root)
  if (state === 'completed')
    return (
      <div data-testid="proposal-applied" className="mx-6 mb-3 rounded-md border border-line bg-surface px-4 py-3 text-[13px]">
        <span className="font-semibold text-text">Applied.</span> {proposal.title}. <ResultLink proposal={proposal} />
      </div>
    )
  if (state === 'canceled' || state === 'failed')
    return (
      <div data-testid="proposal-declined" className="mx-6 mb-3 rounded-md border border-line bg-surface px-4 py-3 text-[13px] text-muted-foreground">
        Declined: {proposal.title}. {root.task?.reason ? '“' + root.task.reason + '”' : ''}
      </div>
    )
  return (
    <div data-testid="proposal" data-kind={proposal.kind} data-task={root.id} className="px-6 pb-3">
      <ApprovalCard
        eyebrow={EYEBROW[proposal.kind]}
        title={proposal.title + '.'}
        reason={[proposal.changes.length ? 'Also ' + proposal.changes.join('; ') + '.' : '', proposal.note].filter(Boolean).join(' ') || undefined}
        approveLabel="Apply"
        onApprove={() => apply(root, proposal)}
        onDecline={() => setDeclining(true)}
      />
      {declining ? (
        <form
          data-testid="decline-form"
          className="mt-2 flex items-center gap-2"
          onSubmit={(event) => {
            event.preventDefault()
            decline(root, reason)
            setDeclining(false)
          }}
        >
          <input autoFocus aria-label="Why (optional)" placeholder="Why (optional)" value={reason} onChange={(event) => setReason(event.target.value)} className="h-7 flex-1 rounded-sm border border-line-strong bg-surface px-2 text-[13px]" />
          <Button type="submit" variant="outline" size="sm">
            Decline
          </Button>
          <Button variant="ghost" size="sm" onClick={() => setDeclining(false)}>
            Never mind
          </Button>
        </form>
      ) : null}
    </div>
  )
}

// A request's record, as the request page and the thread pane's Request panel show it: what was asked,
// what it came to (tasks done, proposals applied, docs, holds, cost), and every step in time order,
// each with who did it, its state now, and a link to its thread.
import { Link } from '@tanstack/react-router'
import { Avatar, TaskState } from '@/components/system'
import { taskState, type Message } from '@/data'
import { named, summaryOf as textSummary } from '@/data/text'
import { useActorNames } from '@/task/actors'
import { useOpenThread } from '@/shell/open-thread'
import { initialsFor } from '@/seats/initials'
import { usd } from '@/routes/seats.$key'
import { entryOf, summaryOf, type Entry } from './model.ts'
import { describe } from '@/task/proposal'
import { usePreviews } from '@/thread/proposal'
import type { RequestRecord } from './use-request.ts'

const time = (iso: string) => new Date(iso).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', second: '2-digit' })

export function useEntries(record: RequestRecord | null): Entry[] {
  const name = useActorNames()
  if (!record) return []
  const at = (actor: string) => '@' + name(actor)
  const out: Entry[] = []
  const root = record.root
  if (root) out.push({ cursor: root.id, at: root.createdAt, kind: 'asked', actor: root.by.actor, text: at(root.by.actor) + ' asked in ' + root.channel + ': ' + textSummary(root.text, named(name)), thread: root.re ?? root.id, channel: root.channel })
  for (const event of record.events) {
    const entry = entryOf(event, at)
    if (entry) out.push({ ...entry, text: textSummary(entry.text, named(name)) || entry.text })
  }
  out.sort((a, b) => Number(a.cursor) - Number(b.cursor))
  // A root that became a task, a proposal, or a doc says so itself: its plain post drops.
  const became = new Set(out.filter((entry) => entry.kind === 'task' || entry.kind === 'proposal' || entry.kind === 'doc').map((entry) => entry.thread))
  // A task or proposal is made once: a later stamp (labels.changed) of one already shown says nothing new.
  const made = new Set<string>()
  return out.filter((entry) => {
    if (entry.kind === 'post') return !became.has(entry.thread)
    if (entry.kind !== 'task' && entry.kind !== 'proposal') return true
    if (made.has(entry.thread)) return false
    made.add(entry.thread)
    return true
  })
}

/** What the request came to, in one line of facts. */
export function RequestFacts({ record }: { record: RequestRecord }) {
  const facts = summaryOf(record.threads)
  const cost = record.runs.reduce((sum, run) => sum + run.cost, 0)
  const seats = [...new Set(record.runs.map((run) => run.seat))]
  return (
    <div data-testid="request-facts" data-cost={cost} className="flex flex-wrap gap-x-4 gap-y-1 font-mono text-mono-ui text-muted-foreground">
      <span data-fact="tasks">
        tasks {facts.tasks.done}/{facts.tasks.all} done{facts.tasks.open ? ', ' + facts.tasks.open + ' open' : ''}
        {facts.tasks.held ? ', ' + facts.tasks.held + ' held' : ''}
      </span>
      <span data-fact="proposals">
        proposals {facts.proposals.applied} applied{facts.proposals.open ? ', ' + facts.proposals.open + ' waiting on you' : ''}
      </span>
      <span data-fact="docs">docs {facts.docs}</span>
      <span data-fact="cost">
        {usd(cost)} over {record.runs.length} {record.runs.length === 1 ? 'run' : 'runs'}
        {seats.length ? ' (' + seats.map((seat) => '@' + seat).join(', ') + ')' : ''}
      </span>
    </div>
  )
}

/** Every step, in time order. */
export function RequestTimeline({ record, limit }: { record: RequestRecord; limit?: number }) {
  const previews = usePreviews(record.threads)
  const entries = useEntries(record).map((entry) => {
    // A proposed change says what it changes, from the board's read of it.
    const thread = entry.kind === 'proposal' ? record.threads.find((one) => one.id === entry.thread) : undefined
    const proposal = thread ? describe(thread, previews.get(thread.id)) : null
    return proposal ? { ...entry, text: entry.text.replace(/proposed: .*$/, 'proposed: ' + proposal.title) } : entry
  })
  const name = useActorNames()
  const { open } = useOpenThread()
  const states = new Map<string, Message>(record.threads.map((one) => [one.id, one]))
  const shown = limit ? entries.slice(-limit) : entries
  return (
    <ol data-testid="request-timeline" className="flex flex-col">
      {limit && entries.length > limit ? <li className="py-1 font-mono text-mono-label text-muted-foreground">{entries.length - limit} earlier steps</li> : null}
      {shown.map((entry) => {
        const thread = states.get(entry.thread)
        const state = thread?.task ? taskState(thread.task) : null
        return (
          <li key={entry.cursor + entry.kind} data-entry={entry.kind} data-cursor={entry.cursor} className="flex items-start gap-2 border-b border-line py-1.5 text-[13px]">
            <span className="w-16 flex-none pt-px font-mono text-mono-label text-muted-foreground tabular-nums">{time(entry.at)}</span>
            {entry.actor ? <Avatar kind={entry.actor.includes('+') || entry.actor.startsWith('worker:') ? 'agent' : 'person'} initials={initialsFor(entry.actor, name(entry.actor), name(entry.actor))} size="xs" /> : <span className="w-4" />}
            <button type="button" className="min-w-0 flex-1 text-left text-body hover:underline" onClick={() => open(entry.thread)}>
              {entry.text}
            </button>
            {state && (entry.kind === 'task' || entry.kind === 'proposal') ? (
              <span className="flex-none" data-state={state.state}>
                <TaskState state={state.state} label={state.word} muted={state.word === 'canceled'} />
              </span>
            ) : null}
          </li>
        )
      })}
    </ol>
  )
}

/** Link to a request's page. */
export function RequestLink({ id, children }: { id: string; children?: React.ReactNode }) {
  return (
    <Link to="/requests/$id" params={{ id }} data-testid="request-link" data-request={id} className="font-mono text-mono-ui text-text underline decoration-line-strong underline-offset-2 hover:decoration-text">
      {children ?? 'Request #' + id}
    </Link>
  )
}

// A seat (design/workbus.md §5): who it is, its state, its charter (its seat doc's prose), what it's
// on now (the threads its sessions run or are parked in, its tasks, the holds it waits on), its
// spend this period against its budget, and its last runs. Live: useSeats polls its Seat.
import { createFileRoute } from '@tanstack/react-router'
import { Avatar, SeatState } from '@/components/system'
import { Markdown } from '@/docs/markdown'
import { ListPane } from '@/shell/list-pane'
import { useOpenThread } from '@/shell/open-thread'
import { Clock } from '@/shell/clock'
import { assigneeOf, isOpen, stateOf } from '@/task/model'
import { useTasks } from '@/task/use-tasks'
import { seatInitials, useSeats } from '@/seats/use-seats'
import type { SeatRun, SeatView } from '@/seats/views'
import { setSeatState } from '@/seats/pause'
import { useBus } from '@/data'
import { useState } from 'react'
import { Button } from '@/components/system'

export const Route = createFileRoute('/seats/$key')({ component: SeatPage })

/** USD as the app shows cost: cents under a dollar keep two places, tiny costs show they're tiny. */
export const usd = (cost: number) => (cost > 0 && cost < 0.01 ? '<$0.01' : '$' + cost.toFixed(2))
const seconds = (run: Pick<SeatRun, 'started' | 'ended'>) => Math.max(0, Math.round((Date.parse(run.ended) - Date.parse(run.started)) / 1000))
const OUTCOME_TONE: Record<string, string> = { answered: 'text-success', ended: 'text-muted-foreground', failed: 'text-danger', aborted: 'text-danger', over_budget: 'text-danger' }

function SeatPage() {
  const { key } = Route.useParams()
  const { seats, ready, error } = useSeats()
  const seat = seats.find((one) => one.key === key)
  if (!seat)
    return (
      <ListPane title={ready ? 'No such seat' : 'Seat'} foot={false}>
        <p className="p-8 text-sm text-muted-foreground">{!ready ? 'Reading the seat…' : error ? "Couldn't read the seats: " + error : 'No seat has the key ' + key + ' in org/seats.'}</p>
      </ListPane>
    )
  return <SeatDetail seat={seat} />
}

/**
 * Pause or resume: an edit to the seat doc as the principal. The button shows what was asked until
 * the Seat's state (polled) says it's applied.
 */
function PauseButton({ seat }: { seat: SeatView }) {
  const bus = useBus()
  const [asked, setAsked] = useState<{ state: 'active' | 'paused'; error: string | null } | null>(null)
  const paused = seat.state === 'paused'
  const pending = asked !== null && asked.error === null && (asked.state === 'paused') !== paused
  const ask = (state: 'active' | 'paused') => {
    setAsked({ state, error: null })
    setSeatState(bus.runtime.client, seat.doc!, state).catch((error: unknown) => setAsked({ state, error: error instanceof Error ? error.message.replace(/^[a-z_]+: /, '') : String(error) }))
  }
  return (
    <div className="flex items-center gap-2">
      {asked?.error ? <span className="text-[12px] text-danger" role="alert">{asked.error}</span> : null}
      <Button data-testid="pause" data-pending={pending ? 'true' : undefined} size="sm" variant="outline" disabled={pending} onClick={() => ask(paused ? 'active' : 'paused')}>
        {pending ? (asked!.state === 'paused' ? 'Pausing…' : 'Resuming…') : paused ? 'Resume' : 'Pause'}
      </Button>
    </div>
  )
}

function SeatDetail({ seat }: { seat: SeatView }) {
  const { open } = useOpenThread()
  const tasks = useTasks().filter((task) => isOpen(task) && assigneeOf(task) === seat.actor)
  const budget = seat.spend.budget
  const share = budget ? Math.min(1, seat.spend.cost / budget) : 0
  return (
    <ListPane title={seat.name} label={'Seat ' + seat.name} foot={false}>
      <div data-testid="seat" data-seat={seat.key} data-state={seat.state} className="mx-auto flex max-w-[760px] flex-col gap-7 px-6 py-6">
        <header className="flex items-center gap-3">
          <Avatar kind="agent" initials={seatInitials(seat)} name={seat.name} size="lg" />
          <div className="min-w-0 flex-1 leading-tight">
            <div className="font-mono text-mono-ui text-muted-foreground">
              @{seat.handle}
              {seat.role ? ' · ' + seat.role : ''}
              {seat.team ? ' · ' + seat.team : ''}
            </div>
          </div>
          {seat.state === 'retired' ? <SeatState state="paused" label="not running" /> : <SeatState state={seat.state} />}
          {seat.doc && seat.state !== 'retired' ? <PauseButton seat={seat} /> : null}
        </header>

        <Section title="Charter" aside={seat.doc ? <button type="button" className="font-mono text-mono-label text-muted-foreground hover:text-text" onClick={() => open(seat.doc!)}>org/seats/{seat.key}</button> : null}>
          <div data-testid="charter" className="text-[13px] leading-[1.6] text-body">
            {seat.charter ? <Markdown compact>{seat.charter.replace(/^# .*\n+/, '').replace(/^#+ Charter\s*\n+/i, '')}</Markdown> : <p className="text-muted-foreground">Its seat doc has no charter yet.</p>}
          </div>
        </Section>

        <Section title="Working on">
          <ul data-testid="working" className="flex flex-col">
            {seat.open.map((one) => (
              <Row key={'t' + one.thread} onClick={() => open(one.thread)} left={'#' + one.thread} right={one.state === 'held' ? 'waiting on you' : one.state} />
            ))}
            {tasks
              .filter((task) => !seat.open.some((one) => one.thread === task.id))
              .map((task) => (
                <Row key={'k' + task.id} onClick={() => open(task.id)} left={'#' + task.id + '  ' + task.text.split('\n')[0]} right={stateOf(task)} />
              ))}
            {seat.open.length === 0 && tasks.length === 0 ? <li className="py-1.5 text-[13px] text-muted-foreground">Nothing right now.</li> : null}
          </ul>
        </Section>

        <Section title="Spend" aside={<span className="font-mono text-mono-label text-muted-foreground">{seat.spend.period}</span>}>
          <div data-testid="spend" data-cost={seat.spend.cost} className="flex flex-col gap-2">
            <div className="flex items-baseline gap-2">
              <span className="text-title-lg tabular-nums text-text">{usd(seat.spend.cost)}</span>
              <span className="font-mono text-mono-ui text-muted-foreground tabular-nums">
                {budget !== null ? 'of ' + usd(budget) + ' · ' : ''}
                {seat.spend.runs} {seat.spend.runs === 1 ? 'run' : 'runs'}
              </span>
            </div>
            {budget !== null ? (
              <div className="h-1 overflow-hidden rounded-full bg-raised" role="meter" aria-label="Budget used" aria-valuemin={0} aria-valuemax={budget} aria-valuenow={seat.spend.cost}>
                <div className={share >= 1 ? 'h-full bg-danger' : 'h-full bg-agent'} style={{ width: Math.max(share * 100, seat.spend.cost > 0 ? 1 : 0) + '%' }} />
              </div>
            ) : null}
          </div>
        </Section>

        <Section title="Runs">
          {seat.runs.length === 0 ? (
            <p className="text-[13px] text-muted-foreground">No runs yet.</p>
          ) : (
            <table data-testid="runs" className="w-full text-[13px]">
              <thead>
                <tr className="text-left font-mono text-mono-label tracking-[0.07em] text-muted-foreground uppercase">
                  <th className="py-1.5 font-normal">Operation</th>
                  <th className="py-1.5 font-normal">Outcome</th>
                  <th className="py-1.5 text-right font-normal">Cost</th>
                  <th className="py-1.5 text-right font-normal">Time</th>
                </tr>
              </thead>
              <tbody>
                {seat.runs.map((run) => (
                  <tr key={run.id} data-run={run.id} className="cursor-default border-t border-line hover:bg-raised" onClick={() => open(run.thread)}>
                    <td className="py-1.5 font-mono text-mono-ui" title={run.operation}>
                      #{run.thread} <span className="text-muted-foreground">{run.operation.slice(0, 18)}</span>
                    </td>
                    <td className={'py-1.5 font-mono text-mono-ui ' + (OUTCOME_TONE[run.outcome] ?? '')} title={run.error ?? undefined}>
                      {run.outcome.replace('_', ' ')}
                    </td>
                    <td className="py-1.5 text-right font-mono text-mono-ui tabular-nums">{usd(run.cost)}</td>
                    <td className="py-1.5 text-right font-mono text-mono-ui text-muted-foreground tabular-nums">
                      <Clock at={run.ended} /> · {run.steps} steps · {seconds(run)}s
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </Section>
      </div>
    </ListPane>
  )
}

function Section({ title, aside, children }: { title: string; aside?: React.ReactNode; children: React.ReactNode }) {
  return (
    <section aria-label={title}>
      <div className="mb-2 flex items-center justify-between font-mono text-mono-label tracking-[0.07em] text-muted-foreground uppercase">
        <h2>{title}</h2>
        {aside}
      </div>
      {children}
    </section>
  )
}

function Row({ left, right, onClick }: { left: string; right: string; onClick: () => void }) {
  return (
    <li>
      <button type="button" onClick={onClick} className="flex w-full items-center justify-between gap-3 border-b border-line py-1.5 text-left text-[13px] hover:bg-raised">
        <span className="min-w-0 truncate">{left}</span>
        <span className="flex-none font-mono text-mono-ui text-muted-foreground">{right}</span>
      </button>
    </li>
  )
}

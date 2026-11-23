// The org (design/workbus.md §4.3, §9.3): its chart when the delegates_to graph has the org-chart
// profile (one root, one delegator per seat, no cycles), every edge between seats as the prototype
// draws them, its teams, and the seat directory with each seat's live state.
import { createFileRoute, Link } from '@tanstack/react-router'
import { ListPane } from '@/shell/list-pane'
import { useSeats } from '@/seats/use-seats'
import { useOrg } from '@/org/use-org'
import { chartOf } from '@/org/chart'
import { ChartTree, EdgeRow, OrgBox, SeatRow, whoOf } from '@/org/parts'

export const Route = createFileRoute('/org/')({ component: OrgPage })

function OrgPage() {
  const { org, error } = useOrg()
  const { seats: live } = useSeats()
  if (!org)
    return (
      <ListPane title="Org & seats" foot={false}>
        <p className="p-8 text-sm text-muted-foreground">{error ? "Couldn't read the org: " + error : 'Reading the org…'}</p>
      </ListPane>
    )
  const who = (key: string) => whoOf(key, org.seats, live)
  const chart = chartOf(org.seats.map((seat) => seat.key), org.edges)
  return (
    <ListPane title="Org & seats" foot={false}>
      <div data-testid="org" className="mx-auto max-w-[860px] px-6 py-6">
        {chart.holds ? (
          <OrgBox title="Org chart" testid="org-chart">
            <div className="overflow-x-auto py-2">
              <div className="flex justify-center">
                <ChartTree at={chart.root} children={chart.children} who={who} />
              </div>
            </div>
          </OrgBox>
        ) : (
          <p data-testid="no-chart" className="mb-4 text-[13px] text-muted-foreground">
            Not an org chart: {chart.why}. The relationships below are the whole graph.
          </p>
        )}
        <OrgBox title="Seat relationships" testid="edges">
          {org.edges.length ? org.edges.map((edge) => <EdgeRow key={edge.team + edge.from + edge.kind + edge.to} edge={edge} from={who(edge.from)} to={who(edge.to)} />) : <p className="text-[13px] text-muted-foreground">No edges yet: a team doc's edges draw them.</p>}
        </OrgBox>
        <h2 className="mt-7 mb-2 font-mono text-mono-label tracking-[0.07em] text-muted-foreground uppercase">Teams</h2>
        <ul data-testid="teams-list" className="mb-6 grid gap-2 sm:grid-cols-2">
          {org.teams.map((team) => (
            <li key={team.slug}>
              <Link to="/org/teams/$slug" params={{ slug: team.slug }} data-team={team.slug} className="block h-full rounded-md border border-line bg-surface p-3 hover:bg-raised">
                <strong className="block font-semibold text-text">{team.name}</strong>
                <span className="mt-1 line-clamp-2 block text-[13px] text-body">{team.purpose.split('\n')[0]}</span>
                <span className="mt-2 block font-mono text-mono-label text-muted-foreground">
                  {team.seats.map((key) => '@' + who(key).handle).join(' ')}
                  {team.queue ? ' · ' + team.queue : ''}
                </span>
              </Link>
            </li>
          ))}
        </ul>
        <h2 className="mb-2 font-mono text-mono-label tracking-[0.07em] text-muted-foreground uppercase">Seat directory</h2>
        <div data-testid="seat-directory">
          {org.seats.map((seat) => (
            <SeatRow key={seat.key} who={who(seat.key)} />
          ))}
        </div>
      </div>
    </ListPane>
  )
}

// A team (design/workbus.md §4.3): its purpose (its doc's prose), its seats with their live states,
// its lead and queue, the teams nested in it, and the edges its doc draws.
import { createFileRoute, Link } from '@tanstack/react-router'
import { Markdown } from '@/docs/markdown'
import { named, typedText } from '@/data/text'
import { useActorNames } from '@/task/actors'
import { ListPane } from '@/shell/list-pane'
import { useOpenThread } from '@/shell/open-thread'
import { useSeats } from '@/seats/use-seats'
import { useOrg } from '@/org/use-org'
import { EdgeRow, OrgBox, SeatRow, whoOf } from '@/org/parts'

export const Route = createFileRoute('/org/teams/$slug')({ component: TeamPage })

function TeamPage() {
  const { slug } = Route.useParams()
  const { org, error } = useOrg()
  const { seats: live } = useSeats()
  const { open } = useOpenThread()
  const name = useActorNames()
  const team = org?.teams.find((one) => one.slug === slug)
  if (!org || !team)
    return (
      <ListPane title={org ? 'No such team' : 'Team'} foot={false}>
        <p className="p-8 text-sm text-muted-foreground">{!org ? (error ? "Couldn't read the org: " + error : 'Reading the team…') : 'No team has the doc org/teams/' + slug + '.'}</p>
      </ListPane>
    )
  const who = (key: string) => whoOf(key, org.seats, live)
  return (
    <ListPane title={team.name} label={'Team ' + team.name} foot={false}>
      <div data-testid="team" data-team={team.slug} className="mx-auto max-w-[760px] px-6 py-6">
        <div className="mb-5 flex flex-wrap items-center gap-x-3 gap-y-1 font-mono text-mono-ui text-muted-foreground">
          <Link to="/org" className="hover:text-text">
            Org
          </Link>
          <span aria-hidden>/</span>
          <button type="button" className="hover:text-text" onClick={() => open(team.doc)}>
            org/teams/{team.slug}
          </button>
          {team.lead ? <span>· led by @{who(team.lead).handle}</span> : null}
          {team.queue ? <span>· queue {team.queue}</span> : null}
        </div>
        <section aria-label="Purpose" className="mb-6">
          <h2 className="mb-2 font-mono text-mono-label tracking-[0.07em] text-muted-foreground uppercase">Purpose</h2>
          <div data-testid="purpose" className="text-[13px] leading-[1.6] text-body">
            {team.purpose ? <Markdown compact>{typedText(team.purpose, named(name))}</Markdown> : <p className="text-muted-foreground">Its doc has no purpose written yet.</p>}
          </div>
        </section>
        <h2 className="mb-2 font-mono text-mono-label tracking-[0.07em] text-muted-foreground uppercase">Seats</h2>
        <div data-testid="team-seats" className="mb-6">
          {team.seats.map((key) => (
            <SeatRow key={key} who={who(key)} />
          ))}
        </div>
        {team.teams.length ? (
          <section aria-label="Teams in it" className="mb-6">
            <h2 className="mb-2 font-mono text-mono-label tracking-[0.07em] text-muted-foreground uppercase">Teams in it</h2>
            {team.teams.map((nested) => (
              <Link key={nested} to="/org/teams/$slug" params={{ slug: nested }} className="mr-3 font-mono text-mono-ui text-text hover:underline">
                {org.teams.find((one) => one.slug === nested)?.name ?? nested}
              </Link>
            ))}
          </section>
        ) : null}
        <OrgBox title="Edges" testid="team-edges">
          {team.edges.length ? team.edges.map((edge) => <EdgeRow key={edge.from + edge.kind + edge.to} edge={edge} from={who(edge.from)} to={who(edge.to)} />) : <p className="text-[13px] text-muted-foreground">Its doc draws no edges.</p>}
        </OrgBox>
      </div>
    </ListPane>
  )
}

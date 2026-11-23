// The sidebar (design/workbus.md §9.3, and the prototype's): search or ask (⌘K), Inbox and My work,
// direct messages, teams with their channels, seats, the workspace's places, and at the foot
// Settings and who you are. Channels group under a team by their first path segment
// (eng/releases is Engineering's releases); dm/<seat> are the direct messages. Rows are the design
// system's SidebarItem.
import { Link, useLocation } from '@tanstack/react-router'
import { useLiveQuery } from '@tanstack/react-db'
import { Activity, CircleDot, FileText, Hash, Inbox, LayoutGrid, MessageSquare, Network, Search, Settings, SquareCheck, Users, type LucideIcon } from 'lucide-react'
import { useBus, type Channel } from '@/data'
import { DocsTree } from '@/docs/DocsTree'
import { useDisplayNames } from './display-name.ts'
import { Avatar, Kbd, Lockup, SidebarGroup, SidebarItem } from '@/components/system'
import { MentionCount, NewChannel, useChannelCounts } from './channel-list.tsx'
import { seatInitials, useSeats } from '@/seats/use-seats'
import type { SeatView } from '@/seats/views'

const icon = (Icon: LucideIcon) => <Icon size={16} strokeWidth={1.5} aria-hidden className="shrink-0 text-muted-foreground" />

/** Channels by team: top-level ones under no team, dm/ apart. */
function arrange(channels: Channel[]) {
  const dms: Channel[] = []
  const loose: Channel[] = []
  const teams = new Map<string, Channel[]>()
  for (const channel of channels) {
    const [first, ...rest] = channel.path.split('/')
    if (first === 'dm') dms.push(channel)
    else if (rest.length === 0) loose.push(channel)
    else teams.set(first!, [...(teams.get(first!) ?? []), channel])
  }
  return { dms, loose, teams: [...teams].sort(([a], [b]) => a.localeCompare(b)) }
}

const initials = (name: string) => name.split(/[\s._-]+/).map((part) => part[0] ?? '').join('').slice(0, 2).toUpperCase() || '?'

export function Sidebar({ inboxCount }: { inboxCount?: number }) {
  const bus = useBus()
  const pathname = useLocation({ select: (location) => location.pathname })
  const { data: channels } = useLiveQuery({ query: (q) => q.from({ channel: bus.channels }).orderBy(({ channel }) => channel.path, 'asc') })
  const { dms, loose, teams } = arrange(channels)
  const { seats } = useSeats()
  // The operator's DM is always there, the one door to the org; a seat's DM shows once it has a channel.
  const operator = seats.find((seat) => seat.role === 'operator')
  const dmPaths = [...new Set([...(operator ? ['dm/' + operator.key] : []), ...dms.map((channel) => channel.path)])]
  const seatOfDm = (path: string) => seats.find((seat) => 'dm/' + seat.key === path)
  const me = bus.runtime.me
  const name = useDisplayNames()(me.actor, me.name ?? me.handle ?? '')
  const at = (path: string) => pathname === path
  // Unread roots make a channel bold with a dot; mentions show as a count instead, in the held color.
  const counts = useChannelCounts()
  const channelLink = (channel: Channel, label: string, child = false) => {
    const count = counts.get(channel.path)
    const unread = (count?.unread ?? 0) > 0 || (count?.mentions ?? 0) > 0
    return (
      <li key={channel.path}>
        <SidebarItem asChild child={child} active={at('/c/' + channel.path)} unread={unread && !count?.mentions} icon={channel.path.startsWith('dm/') ? MessageSquare : Hash} className={unread ? 'font-semibold text-text' : undefined}>
          <Link to="/c/$" params={{ _splat: channel.path }} data-channel={channel.path} data-unread={unread ? 'yes' : undefined}>
            <span className="truncate">{label}</span>
            <MentionCount count={count} />
          </Link>
        </SidebarItem>
      </li>
    )
  }
  // A seat's DM: its square avatar, its name, and @handle at the end (or the unread dot).
  const dmLink = (path: string, seat: SeatView) => {
    const count = counts.get(path)
    const unread = (count?.unread ?? 0) > 0 || (count?.mentions ?? 0) > 0
    return (
      <li key={path}>
        <SidebarItem asChild active={at('/c/' + path)} unread={unread && !count?.mentions} meta={unread ? undefined : '@' + seat.handle} avatar={{ kind: 'agent', initials: seatInitials(seat), name: seat.name }} className={unread ? 'font-semibold text-text' : undefined}>
          <Link to="/c/$" params={{ _splat: path }} data-channel={path} data-seat={seat.key} data-unread={unread ? 'yes' : undefined}>
            <span className="truncate">{seat.name}</span>
            <MentionCount count={count} />
          </Link>
        </SidebarItem>
      </li>
    )
  }
  const place = (to: '/' | '/my-work' | '/docs' | '/tasks' | '/settings', label: string, Icon: LucideIcon, count?: number) => (
    <SidebarItem asChild icon={Icon} active={to === '/' ? at('/') : pathname.startsWith(to)} {...(count ? { count } : {})}>
      <Link to={to}>{label}</Link>
    </SidebarItem>
  )
  const inert = (label: string, Icon: LucideIcon) => (
    <SidebarItem icon={Icon} className="cursor-default opacity-50 hover:bg-transparent" aria-disabled>
      {label}
    </SidebarItem>
  )
  return (
    <nav aria-label="Workspace navigation" data-testid="sidebar" className="flex w-sidebar shrink-0 flex-col border-r border-line bg-sidebar">
      <div className="flex h-[61px] flex-none items-center px-[18px]">
        <Lockup height={22} />
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto px-2.5">
        <button type="button" onClick={() => window.dispatchEvent(new CustomEvent('workbus:command'))} className="mb-[18px] flex h-[30px] w-full items-center gap-2 rounded-sm border border-line-strong bg-surface px-2 text-ui text-muted-foreground">
          {icon(Search)}
          Search or ask
          <Kbd className="ml-auto">⌘ K</Kbd>
        </button>
        {place('/', 'Inbox', Inbox, inboxCount)}
        {place('/my-work', 'My work', CircleDot)}
        {dmPaths.length ? (
          <>
            <SidebarGroup>Direct messages</SidebarGroup>
            <ul data-testid="dms">
              {dmPaths.map((path) => {
                const seat = seatOfDm(path)
                return seat ? dmLink(path, seat) : channelLink(dms.find((channel) => channel.path === path)!, path.slice(3))
              })}
            </ul>
          </>
        ) : null}
        {teams.length ? <SidebarGroup>Teams</SidebarGroup> : null}
        <ul data-testid="teams">
          {teams.map(([team, list]) => (
            <li key={team}>
              <SidebarItem icon={Users} className="cursor-default hover:bg-transparent">
                <span className="capitalize">{team}</span>
              </SidebarItem>
              <ul>{list.map((channel) => channelLink(channel, channel.path.slice(team.length + 1), true))}</ul>
            </li>
          ))}
        </ul>
        <div className="relative flex items-center">
          <SidebarGroup>Channels</SidebarGroup>
          <div className="mt-3 ml-auto pr-1">
            <NewChannel />
          </div>
        </div>
        <ul data-testid="channels">{loose.map((channel) => channelLink(channel, channel.path))}</ul>
        {seats.length ? (
          <>
            <SidebarGroup>Seats</SidebarGroup>
            <ul data-testid="seats">
              {seats.map((seat) => (
                  <li key={seat.key}>
                    <SidebarItem asChild active={at('/seats/' + seat.key)} {...(seat.state === 'retired' ? { meta: 'off' } : { state: seat.state })} avatar={{ kind: 'agent', initials: seatInitials(seat), name: seat.name }}>
                      <Link to="/seats/$key" params={{ key: seat.key }} data-seat={seat.key} data-state={seat.state}>
                        <span className="truncate">{seat.name}</span>
                      </Link>
                    </SidebarItem>
                  </li>
                ))}
            </ul>
          </>
        ) : null}
        <SidebarGroup>Workspace</SidebarGroup>
        {inert('Org & seats', Network)}
        {place('/docs', 'Docs', FileText)}
        <div className="pl-5">
          <DocsTree />
        </div>
        {place('/tasks', 'Tasks', SquareCheck)}
        {inert('Apps', LayoutGrid)}
        {inert('Ops', Activity)}
      </div>
      <div className="border-t border-line px-2.5 py-2">{place('/settings', 'Settings', Settings)}</div>
      <div data-testid="profile" className="flex items-center gap-2 border-t border-line px-4 py-3">
        <Avatar kind="person" initials={initials(name)} name={name} size="md" />
        <div className="min-w-0 leading-tight">
          <strong className="block truncate font-semibold text-text">{name}</strong>
          <small className="font-mono text-mono-label text-muted-foreground">Principal</small>
        </div>
      </div>
    </nav>
  )
}

// The sidebar (design/workbus.md §9.3, and the prototype's): search or ask (⌘K), Inbox and My work,
// direct messages, teams with their channels, seats, the workspace's places, and at the foot
// Settings and who you are. Channels group under a team by their first path segment
// (eng/releases is Engineering's releases); dm/<seat> are the direct messages.
import { Link, useParams } from '@tanstack/react-router'
import { useLiveQuery } from '@tanstack/react-db'
import { Activity, CircleDot, FileText, Hash, Inbox, LayoutGrid, MessageSquare, Network, Search, Settings, Users, type LucideIcon } from 'lucide-react'
import type { ReactNode } from 'react'
import { useBus, type Channel } from '@/data'
import { DocsTree } from '@/docs/DocsTree'
import { cn } from '@/lib/utils'

const row = 'flex h-7 w-full items-center gap-2 rounded-sm px-2 text-sm text-sidebar-foreground hover:bg-sidebar-accent'
const active = { className: 'bg-background text-foreground font-medium shadow-[inset_0_0_0_1px_var(--border)]' }
const icon = (Icon: LucideIcon) => <Icon size={16} strokeWidth={1.5} aria-hidden className="shrink-0 text-muted-foreground" />

function Group({ children }: { children: ReactNode }) {
  return <div className="mt-4 px-2 pb-1 font-mono text-[10.5px] uppercase tracking-wider text-muted-foreground">{children}</div>
}

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

export function Sidebar({ inboxCount }: { inboxCount?: number }) {
  const bus = useBus()
  const docId = useParams({ strict: false, select: (params: { id?: string }) => params.id })
  const { data: channels } = useLiveQuery({ query: (q) => q.from({ channel: bus.channels }).orderBy(({ channel }) => channel.path, 'asc') })
  const { dms, loose, teams } = arrange(channels)
  const me = bus.runtime.me
  const channelLink = (channel: Channel, label: string, child = false) => (
    <li key={channel.path}>
      <Link to="/c/$" params={{ _splat: channel.path }} className={cn(row, child && 'pl-7')} activeProps={active}>
        {icon(channel.path.startsWith('dm/') ? MessageSquare : Hash)}
        <span className="truncate">{label}</span>
      </Link>
    </li>
  )
  return (
    <nav aria-label="Workspace navigation" data-testid="sidebar" className="flex w-52 shrink-0 flex-col border-r border-sidebar-border bg-sidebar">
      <div className="px-4 pt-4 pb-3 text-lg font-semibold tracking-tight">workbus</div>
      <div className="min-h-0 flex-1 overflow-y-auto px-2">
        <button type="button" onClick={() => window.dispatchEvent(new CustomEvent('workbus:command'))} className="mb-3 flex h-8 w-full items-center gap-2 rounded-sm border bg-background px-2 text-sm text-muted-foreground">
          {icon(Search)}
          Search or ask
          <kbd className="ml-auto rounded-sm border px-1 font-mono text-[10.5px]">⌘ K</kbd>
        </button>
        <Link to="/" className={row} activeProps={active} activeOptions={{ exact: true }}>
          {icon(Inbox)}
          Inbox
          {inboxCount ? <span data-testid="inbox-count" className="ml-auto rounded-sm bg-primary px-1.5 font-mono text-[11px] text-primary-foreground">{inboxCount}</span> : null}
        </Link>
        <Link to="/my-work" className={row} activeProps={active}>
          {icon(CircleDot)}
          My work
        </Link>
        {dms.length ? (
          <>
            <Group>Direct messages</Group>
            <ul>{dms.map((channel) => channelLink(channel, channel.path.slice(3)))}</ul>
          </>
        ) : null}
        {teams.length ? <Group>Teams</Group> : null}
        <ul data-testid="teams">
          {teams.map(([team, list]) => (
            <li key={team}>
              <span className={cn(row, 'cursor-default hover:bg-transparent')}>
                {icon(Users)}
                <span className="capitalize">{team}</span>
              </span>
              <ul>{list.map((channel) => channelLink(channel, channel.path.slice(team.length + 1), true))}</ul>
            </li>
          ))}
        </ul>
        {loose.length ? <Group>Channels</Group> : null}
        <ul data-testid="channels">{loose.map((channel) => channelLink(channel, channel.path))}</ul>
        <Group>Workspace</Group>
        <span className={cn(row, 'cursor-default opacity-50 hover:bg-transparent')}>{icon(Network)}Org &amp; seats</span>
        <Link to="/docs" className={row} activeProps={active}>
          {icon(FileText)}
          Docs
        </Link>
        <div className="pl-5">
          <DocsTree {...(docId ? { current: docId } : {})} />
        </div>
        <Link to="/tasks" className={row} activeProps={active}>
          {icon(LayoutGrid)}
          Tasks
        </Link>
        <span className={cn(row, 'cursor-default opacity-50 hover:bg-transparent')}>{icon(LayoutGrid)}Apps</span>
        <span className={cn(row, 'cursor-default opacity-50 hover:bg-transparent')}>{icon(Activity)}Ops</span>
      </div>
      <div className="border-t px-2 py-2">
        <Link to="/settings" className={row} activeProps={active}>
          {icon(Settings)}
          Settings
        </Link>
      </div>
      <div data-testid="profile" className="flex items-center gap-2 border-t px-4 py-3">
        <span aria-hidden className="flex size-7 items-center justify-center rounded-full bg-foreground text-[11px] font-medium text-background">
          {(me.name ?? me.handle ?? '?').slice(0, 2).toUpperCase()}
        </span>
        <div className="min-w-0 leading-tight">
          <strong className="block truncate text-sm">{me.name ?? me.handle ?? ''}</strong>
          <small className="font-mono text-[11px] text-muted-foreground">Principal</small>
        </div>
      </div>
    </nav>
  )
}

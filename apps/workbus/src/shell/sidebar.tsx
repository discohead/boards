// The sidebar (design/workbus.md §9.3): the places, and the channels, live. Teams, seats, Apps, and
// Ops come in later phases; they're shown here, inert, so the frame has their room.
import { Link } from '@tanstack/react-router'
import { useLiveQuery } from '@tanstack/react-db'
import { useBus } from '@/data'
import { cn } from '@/lib/utils'

const PLACES = [
  { to: '/', label: 'Inbox' },
  { to: '/my-work', label: 'My work' },
  { to: '/tasks', label: 'Tasks' },
  { to: '/docs', label: 'Docs' },
] as const

const item = 'block rounded-md px-2 py-1 text-sidebar-foreground/80 hover:bg-sidebar-accent hover:text-sidebar-accent-foreground'
const active = { className: 'bg-sidebar-accent text-sidebar-accent-foreground font-medium' }

export function Sidebar() {
  const bus = useBus()
  const { data: channels } = useLiveQuery({ query: (q) => q.from({ channel: bus.channels }).orderBy(({ channel }) => channel.path, 'asc') })
  return (
    <nav aria-label="Workbus" className="flex w-60 shrink-0 flex-col border-r border-sidebar-border bg-sidebar p-2 text-sm">
      <div className="px-2 py-2 font-semibold">Workbus</div>
      {PLACES.map((place) => (
        <Link key={place.to} to={place.to} className={item} activeProps={active} activeOptions={{ exact: place.to === '/' }}>
          {place.label}
        </Link>
      ))}
      <div className="mt-4 px-2 pb-1 text-xs font-medium text-muted-foreground">Channels</div>
      <ul data-testid="channels">
        {channels.map((channel) => (
          <li key={channel.path}>
            <Link to="/c/$" params={{ _splat: channel.path }} className={item} activeProps={active}>
              # {channel.path}
            </Link>
          </li>
        ))}
      </ul>
      <div className="mt-4 px-2 pb-1 text-xs font-medium text-muted-foreground">Later</div>
      {['Teams', 'Seats', 'Apps', 'Ops'].map((label) => (
        <span key={label} className={cn(item, 'cursor-default opacity-50 hover:bg-transparent')}>
          {label}
        </span>
      ))}
      <div className="mt-auto">
        <Link to="/settings" className={item} activeProps={active}>
          Settings
        </Link>
      </div>
    </nav>
  )
}

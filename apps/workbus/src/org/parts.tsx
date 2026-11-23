// The org views' parts, in the design system: a seat as a chip or a directory row (its square
// avatar, name, @handle, and live state), an edge as the prototype draws it (@from — kind — @to),
// and the org chart, a tree of seat cards joined by lines.
import type { ReactNode } from 'react'
import { Link } from '@tanstack/react-router'
import { ChevronRight } from 'lucide-react'
import { Avatar, SeatState } from '@/components/system'
import type { SeatView } from '@/seats/views'
import { seatInitials } from '@/seats/use-seats'
import type { SeatDocView, Edge } from './views.ts'
import { PRINCIPAL_KEY } from './keys.ts'

export const EDGE_WORD: Record<Edge['kind'], string> = { delegates_to: 'delegates to', escalates_to: 'escalates to', reviews: 'reviews', consults: 'consults' }

export type Who = { key: string; name: string; handle: string; role: string | null; live: SeatView | null }

/** A seat by key, from its doc and its Seat; the principal is You (@you), round. */
export function whoOf(key: string, seats: SeatDocView[], live: SeatView[]): Who {
  if (key === PRINCIPAL_KEY) return { key, name: 'You', handle: 'you', role: 'principal', live: null }
  const doc = seats.find((seat) => seat.key === key)
  const view = live.find((seat) => seat.key === key) ?? null
  return { key, name: view?.name ?? doc?.name ?? key, handle: view?.handle ?? doc?.handle ?? key, role: view?.role ?? doc?.role ?? null, live: view }
}

const initials = (who: Who) => seatInitials({ name: who.name, handle: who.handle })

export function WhoAvatar({ who, size = 'sm' }: { who: Who; size?: 'xs' | 'sm' | 'md' | 'lg' }) {
  return <Avatar kind={who.key === PRINCIPAL_KEY ? 'person' : 'agent'} initials={who.key === PRINCIPAL_KEY ? 'YO' : initials(who)} name={who.name} size={size} />
}

/** Its state, as the system draws it; nothing for the principal, "not running" for a seat its Seat doesn't run. */
export function StateOf({ who }: { who: Who }) {
  if (who.key === PRINCIPAL_KEY) return null
  if (!who.live || who.live.state === 'retired') return <SeatState state="paused" label="not running" />
  return <SeatState state={who.live.state} />
}

/** One edge, as the prototype's relationships box draws it. */
export function EdgeRow({ edge, from, to }: { edge: Edge; from: Who; to: Who }) {
  return (
    <div data-edge={edge.from + ' ' + edge.kind + ' ' + edge.to} className="my-1.5 flex flex-wrap items-center gap-1.5">
      <WhoAvatar who={from} size="xs" />
      <span className="font-mono text-mono-ui text-text">@{from.handle}</span>
      <span className="inline-flex min-w-[120px] items-center justify-center gap-1.5 font-mono text-mono-label text-muted-foreground before:w-3 before:border-t before:border-line-strong after:w-3 after:border-t after:border-line-strong">{EDGE_WORD[edge.kind]}</span>
      <WhoAvatar who={to} size="xs" />
      <span className="font-mono text-mono-ui text-text">@{to.handle}</span>
    </div>
  )
}

/** A seat in the directory: avatar, name, role and @handle, its state, and a way to its page. */
export function SeatRow({ who }: { who: Who }) {
  return (
    <Link to="/seats/$key" params={{ key: who.key }} data-seat={who.key} data-state={who.live?.state ?? 'none'} className="mb-2 flex w-full items-center gap-3 rounded-md border border-line bg-surface p-3 hover:bg-raised">
      <WhoAvatar who={who} size="md" />
      <span className="min-w-0 flex-1 leading-tight">
        <strong className="block truncate font-semibold text-text">{who.name}</strong>
        <small className="block font-mono text-mono-label text-muted-foreground">
          {who.role ? who.role + ' · ' : ''}@{who.handle}
        </small>
      </span>
      <StateOf who={who} />
      <ChevronRight size={16} strokeWidth={1.5} aria-hidden className="text-muted-foreground" />
    </Link>
  )
}

/** A box with a mono heading, as the prototype's graph box. */
export function OrgBox({ title, children, testid }: { title: string; children: ReactNode; testid?: string }) {
  return (
    <section aria-label={title} data-testid={testid} className="mb-5 rounded-md border border-line bg-sidebar p-4">
      <h3 className="mb-2 font-mono text-mono-label tracking-[0.07em] text-muted-foreground uppercase">{title}</h3>
      {children}
    </section>
  )
}

/** A seat card in the chart. */
function ChartCard({ who }: { who: Who }) {
  return (
    <Link to="/seats/$key" params={{ key: who.key }} data-chart-seat={who.key} className="flex min-w-[150px] items-center gap-2 rounded-md border border-line bg-surface px-3 py-2 hover:bg-raised">
      <WhoAvatar who={who} size="md" />
      <span className="min-w-0 leading-tight">
        <strong className="block truncate text-[13px] font-semibold text-text">{who.name}</strong>
        <span className="flex items-center gap-2 font-mono text-mono-label text-muted-foreground">
          @{who.handle} <StateOf who={who} />
        </span>
      </span>
    </Link>
  )
}

/** The org chart: the root on top, each seat's delegates under it, joined by lines. */
export function ChartTree({ at, children, who }: { at: string; children: Map<string, string[]>; who: (key: string) => Who }) {
  const below = children.get(at) ?? []
  return (
    <div className="flex flex-col items-center">
      <ChartCard who={who(at)} />
      {below.length ? (
        <>
          <div aria-hidden className="h-4 w-px bg-line-strong" />
          <div className="flex items-start">
            {below.map((child, i) => (
              <div key={child} className="relative flex flex-col items-center px-3 pt-4">
                {/* The bar across the siblings, and the line down to this one. */}
                {below.length > 1 ? <div aria-hidden className={'absolute top-0 h-px bg-line-strong ' + (i === 0 ? 'left-1/2 right-0' : i === below.length - 1 ? 'left-0 right-1/2' : 'inset-x-0')} /> : null}
                <div aria-hidden className="absolute top-0 left-1/2 h-4 w-px bg-line-strong" />
                <ChartTree at={child} children={children} who={who} />
              </div>
            ))}
          </div>
        </>
      ) : null}
    </div>
  )
}

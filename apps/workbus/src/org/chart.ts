// The org-chart profile (design/workbus.md §4.3): the delegates_to graph among seats with at most
// one incoming delegates_to per seat, no cycles, and one root. When it holds, the org page draws a
// chart; when it doesn't, it says why and shows the graph as its edges.
import type { Edge } from './views.ts'

export type Chart = { holds: true; root: string; children: Map<string, string[]> } | { holds: false; why: string }

export function chartOf(seats: string[], edges: Pick<Edge, 'from' | 'kind' | 'to'>[]): Chart {
  if (seats.length === 0) return { holds: false, why: 'the org has no seats yet' }
  const known = new Set(seats)
  const delegates = edges.filter((edge) => edge.kind === 'delegates_to' && known.has(edge.from) && known.has(edge.to))
  const parent = new Map<string, string>()
  for (const edge of delegates) {
    const had = parent.get(edge.to)
    if (had && had !== edge.from) return { holds: false, why: '@' + edge.to + ' has two seats delegating to it (' + had + ' and ' + edge.from + ')' }
    parent.set(edge.to, edge.from)
  }
  for (const seat of seats) {
    const seen = new Set<string>()
    for (let at: string | undefined = seat; at !== undefined; at = parent.get(at)) {
      if (seen.has(at)) return { holds: false, why: 'delegates_to goes round in a cycle through ' + at }
      seen.add(at)
    }
  }
  const roots = seats.filter((seat) => !parent.has(seat))
  if (roots.length !== 1) return { holds: false, why: roots.length + ' seats have no one delegating to them (' + roots.join(', ') + '), and a chart has one root' }
  const children = new Map<string, string[]>()
  for (const [child, from] of parent) children.set(from, [...(children.get(from) ?? []), child].sort())
  return { holds: true, root: roots[0]!, children }
}

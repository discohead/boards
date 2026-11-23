// The org as the app's views show it (design/workbus.md §4.3, §9.3): its teams (purpose, seats, lead,
// queue, nested teams, edges), its seats as their docs name them, and every edge between seats. A
// server function over org/'s docs, read as the app (the reconciler's reader); the seats' live
// states come from useSeats. Every request reaching it has passed the app's Access check.
import { createServerFn } from '@tanstack/react-start'

import { bus } from '../bus.ts'
import { readOrg } from './reconcile.ts'
import { prose, type OrgDoc, type SeatBlock, type TeamBlock } from './rules.ts'

export type EdgeKind = 'delegates_to' | 'escalates_to' | 'reviews' | 'consults'
export type Edge = { from: string; kind: EdgeKind; to: string; team: string }
export type TeamView = { slug: string; doc: string; name: string; purpose: string; seats: string[]; lead: string | null; queue: string | null; teams: string[]; edges: Edge[] }
export type SeatDocView = { key: string; doc: string; name: string; handle: string; role: string | null }
/** The org's settings, from org/structure's json#org@1: profile 'org-chart' opts into the org chart. */
export type OrgView = { teams: TeamView[]; seats: SeatDocView[]; edges: Edge[]; profile: 'org-chart' | null; at: string }

const blockOf = <T,>(doc: OrgDoc, schema: string) => (doc.blocks.find((block) => block.schema === schema && block.version === 1)?.data ?? null) as T | null

/** A team doc's purpose: its prose, without its title. */
export const purposeOf = (text: string) => prose(text).replace(/^# .*\n+/, '').trim()

export function orgOf(docs: OrgDoc[]): Omit<OrgView, 'at'> {
  const seats: SeatDocView[] = docs
    .filter((doc) => doc.channel === 'org/seats')
    .map((doc) => {
      const block = blockOf<SeatBlock>(doc, 'seat')
      return { key: doc.slug, doc: doc.id, name: block?.name ?? doc.title, handle: (block?.handle ?? doc.slug).replace(/^@/, '').toLowerCase(), role: block?.role ?? null }
    })
    .sort((a, b) => a.key.localeCompare(b.key))
  const teams: TeamView[] = docs
    .filter((doc) => doc.channel === 'org/teams')
    .map((doc) => {
      const block = blockOf<TeamBlock>(doc, 'team')
      const edges = (block?.edges ?? []).map((edge) => ({ ...edge, kind: edge.kind as EdgeKind, team: doc.slug }))
      return { slug: doc.slug, doc: doc.id, name: block?.name ?? doc.title, purpose: purposeOf(doc.text), seats: block?.seats ?? [], lead: block?.lead ?? null, queue: block?.queue ?? null, teams: block?.teams ?? [], edges }
    })
    .sort((a, b) => a.name.localeCompare(b.name))
  const seen = new Set<string>()
  const edges = teams.flatMap((team) => team.edges).filter((edge) => {
    const id = edge.from + ' ' + edge.kind + ' ' + edge.to
    return seen.has(id) ? false : (seen.add(id), true)
  })
  const structure = docs.find((doc) => doc.channel === 'org' && doc.slug === 'structure')
  const settings = structure ? blockOf<{ profile?: string }>(structure, 'org') : null
  return { teams, seats, edges, profile: settings?.profile === 'org-chart' ? 'org-chart' : null }
}

let cached: { at: number; view: OrgView } | null = null
const CACHE_MS = 5_000

export const orgView = createServerFn().handler(async (): Promise<OrgView> => {
  if (cached && Date.now() - cached.at < CACHE_MS) return cached.view
  const view = { ...orgOf(await readOrg(bus())), at: new Date().toISOString() }
  cached = { at: Date.now(), view }
  return view
})

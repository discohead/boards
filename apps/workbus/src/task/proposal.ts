// A proposal (board.doc.proposal) in plain words: what applying it will do. A new doc's body rides in
// its task's text (after its "---"); a change to a doc that's there is read from the board as the
// body it would have (GET /docs/proposals/:task), when the board answers it. The org's docs say what
// changes in the org: a hire ("Creates the seat Dana (@docs), engineer, $0.05 a month"), a team's
// seats and edges, a seat's config; any other doc says what it creates or which sections change.
import type { Message } from '@/data'
import { proposalOf } from './model.ts'

export type ProposalKind = 'hire' | 'team' | 'seat' | 'org' | 'doc'
export type Proposal = {
  kind: ProposalKind
  /** new: creates a doc at path; edit: changes the doc at path. */
  mode: 'new' | 'edit'
  path: string
  /** What applying does, in one line. */
  title: string
  /** More of what changes, a line each. */
  changes: string[]
  /** Why, as its proposer wrote it. */
  note: string
  /** Where applying leads: the seat's page, or the doc. */
  link: { to: 'seat'; key: string } | { to: 'doc'; path: string }
}

/** The board's read of a proposal (GET /docs/proposals/:id): stale when applying it would be refused. */
export type Preview = { kind: 'new' | 'edit'; path: string; current?: string | null; proposed: string; stale?: boolean }

const BLOCK = (schema: string) => new RegExp('```json#' + schema + '@\\d+[^\\n]*\\n([\\s\\S]*?)\\n```')
export function blockData(body: string | null | undefined, schema: string): Record<string, any> | null {
  const found = body ? BLOCK(schema).exec(body) : null
  if (!found) return null
  try {
    return JSON.parse(found[1]!) as Record<string, any>
  } catch {
    return null
  }
}

const usd = (amount: number) => '$' + (amount < 1 ? amount.toFixed(2) : String(Math.round(amount * 100) / 100))
const edgeWord = (kind: string) => kind.replace(/_/g, ' ')
const titleOf = (body: string) => /^#\s+(.+)$/m.exec(body)?.[1]?.trim() ?? ''

/** The note a proposer wrote: the task text's second paragraph, before "Complete this task…". */
function noteOf(text: string) {
  const head = text.split('\n\n---\n\n')[0]!
  const parts = head.split('\n\n').slice(1).filter((part) => !/^Complete this task/.test(part))
  return parts.join('\n\n').trim()
}

/** A seat block in plain words: name (@handle), role, budget. */
export function seatWords(key: string, seat: Record<string, any>) {
  const name = seat.name ?? key
  const handle = (seat.handle ?? key).replace(/^@/, '')
  const parts = [name + ' (@' + handle + ')']
  if (seat.role) parts.push(seat.role)
  if (seat.budget?.month !== undefined) parts.push(usd(Number(seat.budget.month)) + ' a month')
  return parts.join(', ')
}

/** What changes between two team blocks: seats and edges added and removed, lead and queue. */
export function teamChanges(before: Record<string, any> | null, after: Record<string, any>): string[] {
  const out: string[] = []
  const seats = (block: Record<string, any> | null) => new Set<string>(block?.seats ?? [])
  const edges = (block: Record<string, any> | null) => new Set<string>((block?.edges ?? []).map((edge: any) => edge.from + ' ' + edge.kind + ' ' + edge.to))
  const [s0, s1, e0, e1] = [seats(before), seats(after), edges(before), edges(after)]
  for (const seat of s1) if (!s0.has(seat)) out.push('adds the seat @' + seat)
  for (const seat of s0) if (!s1.has(seat)) out.push('removes the seat @' + seat)
  for (const edge of e1) if (!e0.has(edge)) {
    const [from, kind, to] = edge.split(' ')
    out.push('adds ' + from + ' → ' + to + ' ' + kind + ' (' + from + ' ' + edgeWord(kind!) + ' ' + to + ')')
  }
  for (const edge of e0) if (!e1.has(edge)) {
    const [from, kind, to] = edge.split(' ')
    out.push('removes ' + from + ' → ' + to + ' ' + kind)
  }
  if ((before?.lead ?? null) !== (after.lead ?? null)) out.push(after.lead ? 'makes @' + after.lead + ' its lead' : 'leaves it without a lead')
  if ((before?.queue ?? null) !== (after.queue ?? null)) out.push(after.queue ? 'sets its queue to ' + after.queue : 'drops its queue')
  return out
}

/** What changes between two seat blocks, field by field. */
export function seatChanges(before: Record<string, any> | null, after: Record<string, any>): string[] {
  const out: string[] = []
  const show = (value: unknown) => (value === undefined ? 'nothing' : JSON.stringify(value))
  for (const key of [...new Set([...Object.keys(before ?? {}), ...Object.keys(after)])]) {
    const a = before?.[key]
    const b = after[key]
    if (JSON.stringify(a) === JSON.stringify(b)) continue
    if (key === 'budget' && b?.month !== undefined) out.push('sets its budget to ' + usd(Number(b.month)) + ' a month')
    else if (key === 'state') out.push(b === 'paused' ? 'pauses it' : 'makes it active')
    else out.push('sets ' + key + ' to ' + show(b))
  }
  return out
}

/** Sections a body adds, removes, or changes, by heading. */
function sectionChanges(before: string, after: string): string[] {
  const sections = (body: string) => {
    const out = new Map<string, string>()
    let at = '(the top)'
    for (const line of body.split('\n')) {
      const heading = /^#{1,6}\s+(.+)$/.exec(line)
      if (heading) at = heading[1]!.trim()
      out.set(at, (out.get(at) ?? '') + line + '\n')
    }
    return out
  }
  const [a, b] = [sections(before), sections(after)]
  const out: string[] = []
  for (const [title, text] of b) if (!a.has(title)) out.push('adds the section "' + title + '"')
  else if (a.get(title) !== text) out.push('changes "' + title + '"')
  for (const title of a.keys()) if (!b.has(title)) out.push('removes "' + title + '"')
  return out
}

/** A proposal task in plain words; preview is the board's answer for a change to an existing doc. */
export function describe(task: Message, preview?: Preview | null): Proposal | null {
  const label = proposalOf(task)
  if (!label) return null
  const note = noteOf(task.text)
  const isNew = label.startsWith('new:')
  const path = isNew ? label.slice(4) : (preview?.path ?? /\[\[([^\]]+)\]\]/.exec(task.text)?.[1] ?? 'doc #' + label)
  const proposed = isNew ? (task.text.split('\n\n---\n\n')[1] ?? preview?.proposed ?? null) : (preview?.proposed ?? null)
  const slug = path.slice(path.lastIndexOf('/') + 1)
  const docLink = { to: 'doc' as const, path }
  if (path.startsWith('org/seats/') && !path.slice(10).includes('/')) {
    const seat = blockData(proposed, 'seat')
    if (isNew) return { kind: 'hire', mode: 'new', path, title: seat ? 'Creates the seat ' + seatWords(slug, seat) : 'Creates the seat ' + slug, changes: [], note, link: { to: 'seat', key: slug } }
    const changes = seat ? seatChanges(blockData(preview?.current, 'seat'), seat) : []
    return { kind: 'seat', mode: 'edit', path, title: 'Changes the seat ' + slug + (changes.length ? ': ' + changes[0] : ''), changes: changes.slice(1), note, link: { to: 'seat', key: slug } }
  }
  if (path.startsWith('org/teams/') && !path.slice(10).includes('/')) {
    const team = blockData(proposed, 'team')
    if (isNew) return { kind: 'team', mode: 'new', path, title: 'Creates the team ' + (team?.name ?? slug) + (team?.seats?.length ? ' with ' + team.seats.map((one: string) => '@' + one).join(', ') : ''), changes: team ? teamChanges(null, team).filter((one) => !one.startsWith('adds the seat')) : [], note, link: docLink }
    const changes = team ? teamChanges(blockData(preview?.current, 'team'), team) : []
    return { kind: 'team', mode: 'edit', path, title: 'Changes ' + path + (changes.length ? ': ' + changes[0] : ''), changes: changes.slice(1), note, link: docLink }
  }
  if (path.startsWith('org/')) {
    if (isNew) return { kind: 'org', mode: 'new', path, title: 'Creates ' + path + (proposed && titleOf(proposed) ? ': ' + titleOf(proposed) : ''), changes: [], note, link: docLink }
    const changes = proposed && preview?.current ? sectionChanges(preview.current, proposed) : []
    return { kind: 'org', mode: 'edit', path, title: 'Changes ' + path + (changes.length ? ': ' + changes[0] : ''), changes: changes.slice(1), note, link: docLink }
  }
  if (isNew) return { kind: 'doc', mode: 'new', path, title: 'Creates the doc ' + path + (proposed && titleOf(proposed) ? ': ' + titleOf(proposed) : ''), changes: [], note, link: docLink }
  const changes = proposed && preview?.current ? sectionChanges(preview.current, proposed) : []
  return { kind: 'doc', mode: 'edit', path, title: 'Changes ' + path + (changes.length ? ': ' + changes[0] : ''), changes: changes.slice(1), note, link: docLink }
}

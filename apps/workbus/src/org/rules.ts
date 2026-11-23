// The reconciler's rules (design/workbus.md §4.5), as pure functions: from the org's docs as the
// board holds them (blocks already checked against json#seat@1 and json#team@1) to each seat's
// runtime, or the reasons a doc can't apply. Nothing here touches the board, so it's checked in
// node (scripts/org-check.ts) as well as through the real reconciler.

/** A doc in org/, as its root's message view gives it. */
export type OrgDoc = { id: string; channel: string; slug: string; title: string; revision: number; text: string; blocks: { schema: string; version: number; data: unknown }[] }

export type Permission = 'read' | 'post' | 'react' | 'label' | 'edit' | 'sync' | 'manage'
export type Can = Record<string, 'all' | Permission[]>
export type Rule = 'mention' | 'follow' | 'assigned' | 'dm' | 'schedules' | { ready: string } | { docs: string } | { dm: true } | { tail: string }

export type SeatBlock = {
  role?: string
  name?: string
  handle?: string
  avatar?: string
  occupant?: { harness: 'pi'; model: string }
  tools: string[]
  can: Can
  wakes: Rule[]
  approve?: Record<string, string>
  automatic?: string[]
  sessions?: number
  budget?: { month?: number; alert?: number }
  state?: 'active' | 'paused'
}
export type TeamBlock = { name?: string; seats: string[]; lead?: string; queue?: string; teams?: string[]; edges?: { from: string; kind: string; to: string }[] }

/** What the reconciler derives for a seat: its Seat object's config, its Board, and its one wake. */
export type SeatRuntime = {
  key: string
  name: string
  handle: string
  avatar: string | null
  role: string | null
  team: string | null
  model: string
  tools: string[]
  /** The seat's narrowing: its doc's can, plus its own DM. */
  can: Can
  /** Tools behind an approval, with the kind each holds for, and the kinds made automatic (§6.2). */
  approve: Record<string, string>
  automatic: string[]
  sessions: number
  budget: { month: number | null; alert: number }
  state: 'active' | 'paused'
  /** Its wake's rules, by ID, as design/registered-watchers.md takes them. */
  rules: Record<string, Rule>
  /** What its sessions read as their system prompt (§5.2): its charter, its team's doc, the org's root. */
  charter: string
  teamDoc: string | null
  structure: string | null
  /** The seat doc's revision: orders its wake's applies. */
  revision: number
  /** The newest revision among the docs it came from (seat, team, root): orders its Seat's config. */
  configRevision: number
  doc: string
}

export type Problem = { doc: string; path: string; revision: number; why: string }
export type Plan = { seats: SeatRuntime[]; problems: Problem[] }

/** The tools a seat doc may name today (§5.4), and those the design names that aren't built yet. */
export const TOOLS = ['board', 'computer']
const LATER = ['code', 'sandbox', 'browser', 'web']
const DEFAULT_MODEL = 'anthropic/claude-haiku-5-5'
const KEY = /^[a-z][a-z0-9-]{0,31}$/
const KIND = /^[a-z0-9][a-z0-9_.-]*$/
const HANDLE = /^[a-z](?:[a-z0-9-]{0,30}[a-z0-9])?$/
const CHANNEL = /^[a-z0-9][a-z0-9_-]*(?:\/[a-z0-9][a-z0-9_-]*)*$/
const PERMISSIONS: Permission[] = ['read', 'post', 'react', 'label', 'edit', 'sync', 'manage']
const IMPLIES: Record<Permission, Permission[]> = { read: [], post: [], react: ['read'], label: ['read'], edit: ['read'], sync: ['read'], manage: ['read', 'post', 'react', 'label', 'edit', 'sync'] }
/** What a seat may do in its own DM (design/private-channels.md): everything but sync and manage. */
const DM: Permission[] = ['read', 'post', 'react', 'label', 'edit']

export const pathOf = (doc: Pick<OrgDoc, 'channel' | 'slug'>) => doc.channel + '/' + doc.slug

export function expand(grant: 'all' | Permission[]): Permission[] {
  const out = new Set<Permission>()
  const add = (permission: Permission) => {
    if (out.has(permission)) return
    out.add(permission)
    for (const implied of IMPLIES[permission]) add(implied)
  }
  for (const permission of grant === 'all' ? PERMISSIONS : grant) add(permission)
  return PERMISSIONS.filter((permission) => out.has(permission))
}

/** How specific a pattern is for a channel it covers (higher is more), or null: the board's own rule. */
function covers(pattern: string, channel: string, exact: boolean): number | null {
  if (pattern === '*') return 0
  if (pattern.endsWith('/')) {
    const path = pattern.slice(0, -1)
    return channel === path || channel.startsWith(path + '/') ? 1 + path.length : null
  }
  return exact && pattern === channel ? Number.MAX_SAFE_INTEGER : null
}

/** What a can gives where a pattern itself decides, as the board reads it: at *, the * rule; at x/, x's subtree. */
export function atPattern(can: Record<string, Permission[]>, pattern: string): Permission[] {
  if (pattern === '*') return can['*'] ?? []
  const channel = pattern.endsWith('/') ? pattern.slice(0, -1) : pattern
  let best = -1
  let out: Permission[] = []
  for (const [held, permissions] of Object.entries(can)) {
    const at = covers(held, channel, !pattern.endsWith('/'))
    if (at !== null && at > best) (best = at), (out = permissions)
  }
  return out
}

const validPattern = (pattern: string) => pattern === '*' || CHANNEL.test(pattern.endsWith('/') ? pattern.slice(0, -1) : pattern)
const ruleId = (rule: Rule) => (typeof rule === 'string' ? rule : 'ready' in rule ? 'ready' : 'docs' in rule ? 'docs' : 'dm' in rule ? 'dm' : 'tail')

/** A doc's prose: its text without its blocks' fences. */
export function prose(text: string): string {
  return text.replace(/^```json#[a-z][a-z0-9._-]*@\d+[^\n]*\n[\s\S]*?^```[ \t]*$\n?/gm, '').replace(/\n{3,}/g, '\n\n').trim()
}

const blockOf = <T>(doc: OrgDoc, schema: string): { data: T | null; why: string | null } => {
  const found = doc.blocks.filter((block) => block.schema === schema && block.version === 1)
  if (found.length === 0) return { data: null, why: 'it has no `json#' + schema + '@1` block' }
  if (found.length > 1) return { data: null, why: 'it has ' + found.length + ' `json#' + schema + '@1` blocks, and a ' + schema + ' has one' }
  return { data: found[0]!.data as T, why: null }
}

/**
 * The org's docs to each seat's runtime. holds is what the app Worker may do on the board, as
 * its /me says (pattern to permissions): a seat may do no more. A seat whose doc has a problem
 * gets no runtime from this plan (the reconciler leaves what it had); a team with a problem
 * still lends its good seats their team.
 */
export function plan(docs: OrgDoc[], holds: Record<string, Permission[]>): Plan {
  const problems: Problem[] = []
  const refuse = (doc: OrgDoc, why: string) => problems.push({ doc: doc.id, path: pathOf(doc), revision: doc.revision, why })
  const structure = docs.find((doc) => doc.channel === 'org' && doc.slug === 'structure') ?? null
  const seatDocs = docs.filter((doc) => doc.channel === 'org/seats')
  const teamDocs = docs.filter((doc) => doc.channel === 'org/teams').sort((a, b) => (a.slug < b.slug ? -1 : a.slug > b.slug ? 1 : 0))

  // Seats: each doc on its own.
  const seats = new Map<string, { doc: OrgDoc; block: SeatBlock }>()
  for (const doc of seatDocs) {
    const { data, why } = blockOf<SeatBlock>(doc, 'seat')
    if (!data) {
      refuse(doc, why!)
      continue
    }
    const problem = checkSeat(doc, data, holds)
    if (problem) refuse(doc, problem)
    else seats.set(doc.slug, { doc, block: data })
  }
  // Handles are unique on the board: two seats can't both be @x.
  const byHandle = new Map<string, string>()
  for (const [key, { doc, block }] of [...seats].sort(([a], [b]) => (a < b ? -1 : 1))) {
    const handle = (block.handle ?? key).replace(/^@/, '').toLowerCase()
    const other = byHandle.get(handle)
    if (other) {
      refuse(doc, '@' + handle + ' is already ' + other + "'s handle: give this seat another")
      seats.delete(key)
    } else byHandle.set(handle, key)
  }

  // Teams: every seat they name exists, and every edge is between seats that do.
  const teamOf = new Map<string, OrgDoc>()
  const known = new Set(seatDocs.map((doc) => doc.slug))
  for (const doc of teamDocs) {
    const { data, why } = blockOf<TeamBlock>(doc, 'team')
    if (!data) {
      refuse(doc, why!)
      continue
    }
    const missing = data.seats.filter((seat) => !known.has(seat))
    const edges = data.edges ?? []
    const badEdge = edges.find((edge) => !known.has(edge.from) || !known.has(edge.to))
    const teams = new Set(teamDocs.map((team) => team.slug))
    const badTeam = (data.teams ?? []).find((team) => !teams.has(team) || team === doc.slug)
    if (missing.length) refuse(doc, 'it names ' + list(missing.map((seat) => 'org/seats/' + seat)) + ', which ' + (missing.length === 1 ? "doesn't" : "don't") + ' exist')
    else if (data.lead !== undefined && !data.seats.includes(data.lead)) refuse(doc, 'its lead, ' + data.lead + ", isn't one of its seats")
    else if (badEdge) refuse(doc, 'its edge ' + badEdge.from + ' ' + badEdge.kind + ' ' + badEdge.to + ' names ' + (!known.has(badEdge.from) ? badEdge.from : badEdge.to) + ', which has no doc in org/seats')
    else if (edges.some((edge) => edge.from === edge.to)) refuse(doc, 'an edge goes from a seat to itself')
    else if (badTeam) refuse(doc, 'it nests ' + badTeam + ", which isn't another team in org/teams")
    else if (data.queue !== undefined && !CHANNEL.test(data.queue)) refuse(doc, 'its queue, ' + data.queue + ", isn't a channel")
    else for (const seat of data.seats) if (!teamOf.has(seat)) teamOf.set(seat, doc)
  }

  const out: SeatRuntime[] = []
  for (const [key, { doc, block }] of seats) {
    const team = teamOf.get(key) ?? null
    const can: Can = { ...block.can }
    const dm = 'dm/' + key + '/'
    if (!Object.keys(can).some((pattern) => pattern === dm || pattern === 'dm/' + key)) can[dm] = DM
    const rules: Record<string, Rule> = {}
    for (const rule of block.wakes) {
      const base = ruleId(rule)
      let id = base
      for (let n = 2; id in rules; n++) id = base + '-' + n
      rules[id] = rule === 'dm' ? 'dm' : rule
    }
    out.push({
      key,
      name: block.name ?? doc.title,
      handle: (block.handle ?? key).replace(/^@/, '').toLowerCase(),
      avatar: block.avatar ?? null,
      role: block.role ?? null,
      team: team?.slug ?? null,
      model: block.occupant?.model ?? DEFAULT_MODEL,
      tools: block.tools,
      can,
      approve: block.approve ?? {},
      automatic: block.automatic ?? [],
      sessions: block.sessions ?? 1,
      budget: { month: block.budget?.month ?? null, alert: block.budget?.alert ?? 0.8 },
      state: block.state ?? 'active',
      rules,
      charter: prose(doc.text),
      teamDoc: team ? prose(team.text) : null,
      structure: structure ? prose(structure.text) : null,
      revision: doc.revision,
      configRevision: Math.max(doc.revision, team?.revision ?? 0, structure?.revision ?? 0),
      doc: doc.id,
    })
  }
  return { seats: out.sort((a, b) => (a.key < b.key ? -1 : 1)), problems }
}

const list = (items: string[]) => (items.length <= 2 ? items.join(' and ') : items.slice(0, -1).join(', ') + ', and ' + items.at(-1))

/** The first reason a seat doc can't apply, or null. */
function checkSeat(doc: OrgDoc, block: SeatBlock, holds: Record<string, Permission[]>): string | null {
  if (!KEY.test(doc.slug)) return 'a seat\'s slug is its key: a lowercase letter, then up to 31 lowercase letters, numbers, and hyphens'
  const handle = (block.handle ?? doc.slug).replace(/^@/, '').toLowerCase()
  if (!HANDLE.test(handle)) return '@' + handle + " isn't a handle: 1 to 32 lowercase letters, numbers, and hyphens, starting with a letter"
  if (handle === 'me') return '@me is reserved: filters read it as the caller'
  if (!block.tools.includes('board')) return 'every seat has the board tool: add "board" to its tools'
  for (const tool of block.tools) {
    if (LATER.includes(tool) || tool.startsWith('mcp:') || tool.startsWith('app:')) return 'the ' + tool + " tool isn't built yet: today a seat's tools are " + list(TOOLS)
    if (!TOOLS.includes(tool)) return tool + " isn't a tool: a seat's tools are " + list(TOOLS)
  }
  if (block.role === 'operator' && block.tools.some((tool) => tool !== 'board')) return 'the operator only orchestrates: its only tool is board (§5.8)'
  for (const [pattern, grant] of Object.entries(block.can)) {
    if (!validPattern(pattern)) return 'its can names ' + pattern + ', which is neither *, a channel, nor a channel and its subtree (eng/)'
    const has = atPattern(holds, pattern)
    const more = expand(grant).filter((permission) => !has.includes(permission))
    if (more.length) return 'its can gives ' + list(more) + ' at ' + pattern + ', more than the app holds there (' + (has.length ? has.join(', ') : 'nothing') + '): a seat may do no more than the app'
  }
  // Its notebook's channel (org/seats/<seat>/) may be more; org/ itself is post, never edit (§4.4).
  for (const at of ['org', 'org/', 'org/seats', 'org/teams'])
    if (atPatternOf(block.can, at).includes('edit')) return "seats post in org/ but don't edit it, so their changes to the org are proposals: its can gives edit at " + at
  for (const [tool, kind] of Object.entries({ ...block.approve })) if (!KIND.test(kind)) return 'the approval kind for ' + tool + ', ' + kind + ", isn't a kind: lowercase letters, numbers, and _.-"
  for (const kind of block.automatic ?? []) if (!KIND.test(kind)) return kind + " isn't an approval kind: lowercase letters, numbers, and _.-"
  // A ready queue or docs path it serves has to be one it can read.
  for (const rule of block.wakes) {
    const channel = typeof rule === 'object' ? ('ready' in rule ? rule.ready : 'docs' in rule ? rule.docs : null) : null
    if (channel === null) continue
    const bare = channel.endsWith('/') ? channel.slice(0, -1) : channel
    if (!CHANNEL.test(bare)) return 'its wake rule names ' + channel + ", which isn't a channel"
    const readable = expand(atPatternOf(block.can, channel))
    if (!readable.includes('read')) return 'it wakes for ' + channel + ' but its can gives it no read there'
  }
  return null
}

const atPatternOf = (can: Can, pattern: string): Permission[] => atPattern(Object.fromEntries(Object.entries(can).map(([key, grant]) => [key, expand(grant)])), pattern)

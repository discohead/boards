// The Ledger's core: who is calling, what they may do, the log, and the views every operation
// answers. An operation is a synchronous function over one transaction: it reads, decides, writes
// its events and its tables, and returns a view, or throws a WorkbusError and writes nothing.
import { WorkbusError, forbidden, notFound } from '../errors.ts'
import { accessOf, canMap, decide, expand, PERMISSION_PHRASE, type Access, type Grant, type Permission } from './access.ts'
import { json, type Sql } from './sql.ts'
import { canonicalEmoji, findBlocks, mentionTerms } from './text.ts'

export type PrincipalKind = 'person' | 'deployment' | 'workflow' | 'external'
export type Principal = {
  id: string
  kind: PrincipalKind
  handle: string
  name: string
  /** What grants match: the issuer and claims of its credential. Null for the board's own code. */
  facts: { issuer: string; claims: Record<string, unknown> } | null
  expiresAt: number | null
  /** A person's role on the board: an owner manages everything, a viewer reads and reacts. */
  role?: 'owner' | 'member' | 'viewer'
  /** The board's own code: everything, outside the grants (and inside private channels, unless outsider). */
  own?: boolean
  /** Owned code that private channels still keep out: a config watcher that didn't ask for them. */
  outsider?: boolean
}
export type Profile = { name: string; avatar: string | null }
export type Caller = { principal: Principal; profile: Profile | null; narrow: Record<string, Grant> | null; via: string }
export type Author = { actor: string; principal: string; profile: string | null }
export type ActorRecord = { id: string; kind: string; handle: string; name: string; avatar: string | null; via?: { name: string; environment: string | null }; platform?: string; verified?: boolean }

export const actorOf = (caller: Caller): ActorRecord => {
  const { principal, profile } = caller
  if (!profile) return { id: principal.id, kind: principal.kind, handle: principal.handle, name: principal.name, avatar: null, verified: true }
  const lower = profile.name.toLowerCase()
  return { id: principal.id + '+' + lower, kind: 'agent', handle: principal.handle + '/' + lower, name: profile.name, avatar: profile.avatar, via: { name: principal.handle, environment: null }, verified: true }
}
export const authorOf = (caller: Caller): Author => ({ actor: actorOf(caller).id, principal: caller.principal.id, profile: caller.profile ? caller.profile.name.toLowerCase() : null })

// ---------------------------------------------------------------------------------------------
// Grants: who they name, and what they give where.

export type GrantPrincipal = Record<string, unknown> & { kind: string }
export type StoredGrant = { id: string; n: number; principals: GrantPrincipal[]; can: Record<string, Grant>; by: string; at: number }

/** The grants every board starts with, before any write: people everything, the account's Workers what a deployment needs. */
export const STARTING_GRANTS: StoredGrant[] = [
  { id: 'g1', n: 1, principals: [{ kind: 'all-users' }], can: { '*': 'all' }, by: 'workbus', at: 0 },
  { id: 'g2', n: 2, principals: [{ kind: 'all-workers' }], can: { '*': ['read', 'post', 'react', 'label', 'sync'] }, by: 'workbus', at: 0 },
  { id: 'g3', n: 3, principals: [{ kind: 'all-apps' }], can: { '*': ['read', 'post', 'react', 'label'] }, by: 'workbus', at: 0 },
]

/** How closely a grant principal names a caller: 0 by name, 1 as a group, 2 everyone; null when it doesn't. */
export function levelOf(named: GrantPrincipal, principal: Principal): 0 | 1 | 2 | null {
  const claims = principal.facts?.claims ?? {}
  const str = (value: unknown) => (typeof value === 'string' ? value : value === undefined || value === null ? undefined : String(value))
  switch (named.kind) {
    case 'everyone':
      return 2
    case 'all-users':
      return principal.kind === 'person' ? 1 : null
    case 'all-workers':
      return principal.kind === 'deployment' && principal.id.startsWith('worker:') ? 1 : null
    case 'all-apps':
      return null
    case 'user': {
      if (principal.kind !== 'person') return null
      const id = str(named.userId ?? named.id)
      const email = str(named.email)?.toLowerCase()
      const sub = str(claims.sub)
      if (id && (principal.id === 'workbus:user:' + id || principal.id === 'access:user:' + id || sub === id || principal.id === id)) return 0
      if (email && str(claims.email)?.toLowerCase() === email) return 0
      return null
    }
    case 'worker': {
      const script = str(named.script ?? named.worker)
      return script && principal.id === 'worker:' + script ? 0 : null
    }
    // A project is one of the account's Workers in the environments it names (a workload token's
    // environment claim, production when it has none); all-projects is every Worker in them.
    case 'project':
    case 'all-projects': {
      if (principal.kind !== 'deployment' || !principal.id.startsWith('worker:')) return null
      if (named.kind === 'project' && principal.id !== 'worker:' + str(named.projectId ?? named.project)) return null
      const environments = Array.isArray(named.environments) ? named.environments.map(String) : null
      if (environments && !environments.includes(str(claims.environment) ?? 'production')) return null
      return named.kind === 'project' ? 0 : 1
    }
    case 'github': {
      if (principal.facts?.issuer !== 'github') return null
      const repo = str(named.repository)?.toLowerCase()
      const repoId = str(named.repositoryId)
      if (repoId && str(claims.repository_id) !== repoId) return null
      if (!repoId && repo && str(claims.repository)?.toLowerCase() !== repo) return null
      if (named.workflow !== undefined && !str(claims.workflow_ref)?.includes('/' + str(named.workflow))) return null
      if (named.branch !== undefined && str(claims.ref) !== 'refs/heads/' + str(named.branch)) return null
      if (named.event !== undefined && str(claims.event_name) !== str(named.event)) return null
      return 0
    }
    case 'oidc': {
      if (principal.facts?.issuer !== str(named.issuer)) return null
      const wanted = (named.claims ?? {}) as Record<string, unknown>
      for (const [key, value] of Object.entries(wanted)) {
        const values = Array.isArray(value) ? value.map(String) : [String(value)]
        if (!values.includes(str(claims[key]) ?? '\u0000')) return null
      }
      return Object.keys(wanted).length > 0 ? 0 : null
    }
    default:
      return null
  }
}

/**
 * A deployment's private channels (design/private-channels.md): a channel's parties, or null where
 * the grants decide. A party is an actor ID, or owners (any person whose role is owner).
 */
export type Privacy = (channel: string) => readonly string[] | null | undefined

/** dm/<seat> and its subtree, private to the board's owners and the seat: principal's profile <seat>, as worker:workbus-app+ada. */
export function dms(principal: string): Privacy {
  return (channel) => {
    const seat = /^dm\/([a-z0-9][a-z0-9_-]*)(?:\/|$)/.exec(channel)?.[1]
    return seat ? ['owners', principal + '+' + seat] : null
  }
}

/** Whether a caller is one of a private channel's parties. */
export function partyTo(parties: readonly string[], caller: Caller): boolean {
  if (parties.includes(actorOf(caller).id)) return true
  return parties.includes('owners') && caller.principal.kind === 'person' && caller.principal.role === 'owner'
}

/** The private channels closed to a caller, as a test of a channel's name; null when none can be. */
function closedTo(privacy: Privacy | null, caller: Caller): ((channel: string) => boolean) | null {
  if (!privacy || (caller.principal.own && !caller.principal.outsider)) return null
  const known = new Map<string, boolean>()
  return (channel) => {
    let closed = known.get(channel)
    if (closed === undefined) {
      const parties = privacy(channel)
      known.set(channel, (closed = Boolean(parties) && !partyTo(parties!, caller)))
    }
    return closed
  }
}

/** What a caller may do, from the grants as they are now, with the private channels it isn't a party to closed. */
export function accessFor(grants: StoredGrant[], caller: Caller, privacy: Privacy | null = null): Access {
  const { principal } = caller
  const closed = closedTo(privacy, caller)
  if (principal.own) return accessOf({ full: true, grants: [], narrow: caller.narrow, closed })
  const matching = grants.flatMap((grant) => {
    const levels = grant.principals.map((named) => levelOf(named, principal)).filter((level): level is 0 | 1 | 2 => level !== null)
    return levels.length ? [{ grant, level: Math.min(...levels) as 0 | 1 | 2 }] : []
  })
  // everyone shapes what callers something else lets in; it lets no one in itself.
  const admitted = principal.kind === 'person' || matching.some((entry) => entry.level < 2)
  const cap: Permission[] | null = principal.role === 'viewer' ? ['read', 'react'] : null
  const resolve = (channel: string): Permission[] => {
    if (!admitted) return []
    let best = -1
    for (const { grant } of matching) for (const pattern of Object.keys(grant.can)) {
      const at = specificityOf(pattern, channel)
      if (at !== null && at > best) best = at
    }
    if (best < 0) return []
    const atBest = matching.filter(({ grant }) => Object.keys(grant.can).some((pattern) => specificityOf(pattern, channel) === best))
    const closest = Math.min(...atBest.map((entry) => entry.level))
    const out = new Set<Permission>()
    for (const { grant, level } of atBest) {
      if (level !== closest) continue
      for (const [pattern, given] of Object.entries(grant.can)) if (specificityOf(pattern, channel) === best) for (const permission of expand(given)) out.add(permission)
    }
    return [...out].filter((permission) => !cap || cap.includes(permission))
  }
  return accessOf({ full: false, grants: matching.map(({ grant }) => grant.can), narrow: caller.narrow, resolve, closed })
}

function specificityOf(pattern: string, channel: string): number | null {
  if (pattern === '*') return 0
  if (pattern.endsWith('/')) {
    const path = pattern.slice(0, -1)
    return channel === path || channel.startsWith(path + '/') ? 1 + path.length : null
  }
  return pattern === channel ? Number.MAX_SAFE_INTEGER : null
}

export function authorize(access: Access, permission: Permission, channel: string, hidden?: () => Error): void {
  if (hidden && !access.readable(channel)) throw hidden()
  if (!access.can(permission, channel)) throw forbidden("this token can't " + PERMISSION_PHRASE[permission](channel))
}

// ---------------------------------------------------------------------------------------------
// Messages as rows, facets (what filters see), and views.

export type MessageRow = {
  id: number
  thread: number
  thread_key: string
  platform_text: number
  channel: string
  re: number | null
  reply_to: number | null
  actor: string
  principal: string
  profile: string | null
  from_key: string | null
  origin: string | null
  text: string
  labels: string
  reactions: string
  attachments: string | null
  links: string | null
  schedule: string | null
  undelivered: string | null
  no_sync: number
  deleted: number
  blind: number
  imported_by: string | null
  version: number
  revision: number
  client_key: string | null
  created_at: number
  edited_at: number | null
}

/** What a filter reads of a message: enough to match it later without folding the log. */
export type Facet = {
  id: number
  channel: string
  re: number | null
  actor: string
  principal: string
  from: string | null
  labels: Record<string, string>
  rootLabels: Record<string, string>
  text: string
  terms: string[]
  deleted: boolean
  /** Who follows what the message is in (follows.ts), when the event was written. */
  followers?: string[]
}

export const ref = (n: number) => String(n)
export const iso = (ms: number) => new Date(ms).toISOString()

export type ViewOptions = {
  /** What the reader may read: links to messages it can't read show as unavailable. */
  access: Access
  taskView?: (root: number) => unknown | undefined
  /** What other parts add to the view: a doc root's doc, a doc comment's section. */
  extras?: (row: MessageRow) => Record<string, unknown> | undefined
}

export class Board {
  head = 0
  /** The syncs that keep docs in step (a deployment's providers with docTarget): for a doc's path, a target prefix or null. */
  docTargets: ((path: string) => string | null)[] = []
  /** Asked for each message ID that has no row: archival (archive.ts) answers an archived one, or faults it in. */
  miss: ((id: number) => MessageRow | null) | null = null
  /** The board's own syncs, as its deployment declares them: each key, and its platform. */
  sync = new Map<string, string>()
  /** The deployment's private channels (WorkbusConfig.private). */
  privacy: Privacy | null = null
  private grantsCache: { version: number; grants: StoredGrant[] } | null = null
  readonly sql: Sql
  constructor(sql: Sql) {
    this.sql = sql
    this.head = (sql.one<{ head: number | null }>('select max(head) as head from (select max(seq) as head from events union all select max(last) from segments)')?.head ?? 0) || 0
  }

  // -- grants -------------------------------------------------------------------------------
  grantsVersion(): number {
    return Number(this.sql.one<{ value: string }>("select value from meta where key = 'grants_version'")?.value ?? 0)
  }
  bumpGrants() {
    this.sql.run("insert into meta (key, value) values ('grants_version', '1') on conflict (key) do update set value = cast(cast(value as integer) + 1 as text)")
    this.grantsCache = null
  }
  grants(): StoredGrant[] {
    const version = this.grantsVersion()
    if (this.grantsCache?.version === version) return this.grantsCache.grants
    const stored = this.sql.all<{ id: string; n: number; principals: string; can: string; by: string; at: number; revoked: number }>('select * from grants order by n')
    const byId = new Map(STARTING_GRANTS.map((grant) => [grant.id, grant]))
    for (const row of stored) {
      if (row.revoked) byId.delete(row.id)
      else byId.set(row.id, { id: row.id, n: row.n, principals: JSON.parse(row.principals), can: JSON.parse(row.can), by: row.by, at: row.at })
    }
    const grants = [...byId.values()].sort((a, b) => a.n - b.n)
    this.grantsCache = { version, grants }
    return grants
  }
  access(caller: Caller): Access {
    return accessFor(this.grants(), caller, this.privacy)
  }
  /** A channel's parties when it's private, else null. */
  partiesOf(channel: string): readonly string[] | null {
    return this.privacy?.(channel) ?? null
  }

  // -- actors -------------------------------------------------------------------------------
  actor(id: string): ActorRecord | null {
    const row = this.sql.one<{ id: string; kind: string; handle: string; name: string; avatar: string | null; via: string | null; platform: string | null; verified: number }>('select * from actors where id = ?', id)
    return row ? { id: row.id, kind: row.kind, handle: row.handle, name: row.name, avatar: row.avatar, ...(row.via ? { via: JSON.parse(row.via) } : {}), ...(row.platform ? { platform: row.platform } : {}), ...(row.verified ? { verified: true } : {}) } : null
  }
  actorView(record: ActorRecord | null) {
    if (!record) return null
    return { kind: record.kind, handle: record.handle, name: record.name, avatar: record.avatar, ...(record.via ? { via: record.via } : {}), ...(record.platform ? { platform: record.platform } : {}), ...(record.verified ? { verified: true as const } : {}) }
  }
  /** Records an actor as it shows now; an actor.seen event when it's new or its display changed. */
  seen(record: ActorRecord, at: number): void {
    const old = this.actor(record.id)
    const same = old && old.kind === record.kind && old.handle === record.handle && old.name === record.name && old.avatar === record.avatar && JSON.stringify(old.via ?? null) === JSON.stringify(record.via ?? null) && Boolean(old.verified) === Boolean(record.verified)
    if (same) return
    const principal = record.id.split('+')[0]!
    const profile = record.id.includes('+') ? record.id.slice(record.id.indexOf('+') + 1) : null
    this.sql.run(
      'insert into actors (id, principal, profile, kind, handle, handle_lc, name, avatar, via, platform, verified, seen) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) on conflict (id) do update set kind = excluded.kind, handle = excluded.handle, handle_lc = excluded.handle_lc, name = excluded.name, avatar = excluded.avatar, via = excluded.via, platform = excluded.platform, verified = excluded.verified, seen = excluded.seen',
      record.id, principal, profile, record.kind, record.handle, record.handle.toLowerCase(), record.name, record.avatar, record.via ? JSON.stringify(record.via) : null, record.platform ?? null, record.verified ? 1 : 0, at,
    )
    const payload: Record<string, unknown> = { actor: record.id, kind: record.kind, handle: record.handle, name: record.name, avatar: record.avatar }
    if (record.via) payload.via = record.via
    if (record.platform) payload.platform = record.platform
    if (record.verified) payload.verified = true
    this.append('actor.seen', payload, { at })
  }

  // -- the log ------------------------------------------------------------------------------
  /** A message's facet as it is now: what a filter matches it on. Null when there's no such message. */
  facet(id: number): Facet | null {
    const row = this.message(id)
    if (!row) return null
    const labels = row.deleted ? {} : json<Record<string, string>>(row.labels, {})
    const rootLabels = row.re === null ? labels : this.rootLabels(row.re)
    // A doc's facet (docs.ts) is its title and the headings of what last changed, not its body.
    const doc = row.re === null && !row.deleted ? this.sql.one<{ facet_text: string; facet_terms: string }>('select facet_text, facet_terms from docs where root = ?', row.id) : null
    const text = row.deleted ? '' : doc ? doc.facet_text : row.text
    const terms = row.deleted ? [] : doc ? json<string[]>(doc.facet_terms, []) : mentionTerms(row.text)
    const followers = row.deleted ? [] : this.followers(row)
    return { id: row.id, channel: row.channel, re: row.re, actor: row.actor, principal: row.principal, from: row.from_key, labels: withTask(this, row, labels), rootLabels: row.re === null ? withTask(this, row, labels) : rootLabels, text, terms, deleted: Boolean(row.deleted), ...(followers.length ? { followers } : {}) }
  }

  /** What a message is in, for following (follows.ts): its thread, or in a doc's thread, its discussion (a top-level comment and the replies under it). */
  unitOf(row: MessageRow): { root: number; discussion: number } {
    const root = row.re ?? row.id
    if (row.re === null || !this.sql.one('select 1 as there from docs where root = ?', root)) return { root, discussion: 0 }
    let head = row
    for (let depth = 0; head.reply_to !== null && depth < 500; depth++) {
      const up = this.message(head.reply_to)
      if (!up || up.re === null) break
      head = up
    }
    return { root, discussion: head.id }
  }

  /** Who follows what a message is in: its thread, and in a doc, its discussion. */
  followers(row: MessageRow): string[] {
    const unit = this.unitOf(row)
    return this.sql.all<{ actor: string }>('select distinct actor from follows where root = ? and discussion in (0, ?) and following = 1 order by actor limit 200', unit.root, unit.discussion).map((found) => found.actor)
  }
  private rootLabels(root: number): Record<string, string> {
    const row = this.message(root)
    if (!row || row.deleted) return {}
    return withTask(this, row, json<Record<string, string>>(row.labels, {}))
  }

  /**
   * Appends one event, at the next position. For an event about a message, pass the message and
   * its facet from before the change (null for a new post); the facet after is read here, so call
   * it after the tables are written.
   */
  append(type: string, payload: Record<string, unknown>, where: { at: number; message?: number | null; thread?: number | null; before?: Facet | null; seq?: number }): number {
    const seq = where.seq ?? ++this.head
    const message = where.message ?? null
    const after = message === null ? null : this.facet(message)
    const facets = message === null ? null : { before: where.before ?? null, after }
    const by = payload.by as Author | undefined
    this.sql.run(
      'insert into events (seq, type, thread, message, actor, at, payload, facets) values (?, ?, ?, ?, ?, ?, ?, ?)',
      seq, type, where.thread ?? null, message, by?.actor ?? null, where.at, JSON.stringify(payload), JSON.stringify(facets),
    )
    return seq
  }
  /** The next position, taken now: a post's ID is its event's position, and its row is written first. */
  reserve(): number {
    return ++this.head
  }

  // -- rows and views -----------------------------------------------------------------------
  message(id: number): MessageRow | null {
    const row = this.sql.one<MessageRow>('select * from messages where id = ?', id)
    return row ?? (this.miss ? this.miss(id) : null)
  }

  view(row: MessageRow, options: ViewOptions): Record<string, unknown> {
    const deleted = Boolean(row.deleted)
    const labels = deleted ? {} : json<Record<string, string>>(row.labels, {})
    const task = row.re === null && options.taskView ? options.taskView(row.id) : undefined
    if (task && !deleted) (labels as Record<string, string>)['board.task'] = (task as { state: string }).state
    const reactions: Record<string, string[]> = {}
    if (!deleted)
      for (const [emoji, actors] of Object.entries(json<Record<string, string[]>>(row.reactions, {}))) {
        const name = canonicalEmoji(emoji)
        const list = (reactions[name] ??= [])
        for (const actor of actors) if (!list.includes(actor)) list.push(actor)
      }
    for (const [name, list] of Object.entries(reactions)) if (list.length === 0) delete reactions[name]
    const blocks = deleted || row.from_key !== null || row.platform_text ? [] : findBlocks(row.text).filter((block) => block.data && block.schema).map((block) => ({ schema: block.schema!, version: block.version!, data: block.data! }))
    const links = deleted ? [] : json<{ url: string; message: number | null; snapshot: unknown; unavailable: string | null }[]>(row.links, []).map((link) => this.linkView(link, options.access))
    const view: Record<string, unknown> = {
      id: ref(row.id),
      channel: row.channel,
      text: deleted ? '' : row.text,
      re: row.re === null ? null : ref(row.re),
      replyTo: row.reply_to === null ? null : ref(row.reply_to),
      thread: row.thread_key,
      labels,
      reactions,
      by: { actor: row.actor, principal: row.principal, profile: row.profile },
      noSync: Boolean(row.no_sync),
      origin: json(row.origin, null),
      from: row.from_key,
      createdAt: iso(row.created_at),
      editedAt: row.edited_at === null ? null : iso(row.edited_at),
      deleted,
      undelivered: json<Record<string, string>>(row.undelivered, {}),
      attachments: deleted ? [] : json(row.attachments, []),
      links,
      version: row.version,
      revision: row.revision,
      author: this.actorView(this.actor(row.actor)),
      blocks,
    }
    const schedule = json<{ id: number; n: number } | null>(row.schedule, null)
    if (schedule) view.schedule = { id: 's' + schedule.id, n: schedule.n }
    if (task) view.task = task
    if (row.blind) view.blind = true
    if (!deleted && options.extras) Object.assign(view, options.extras(row) ?? {})
    return view
  }

  linkView(link: { url: string; message: number | null; snapshot: unknown; unavailable: string | null }, access: Access) {
    if (link.message === null) return { url: link.url, message: null, snapshot: link.snapshot ?? null, unavailable: link.unavailable ?? null }
    const target = this.message(link.message)
    if (!target || !access.readable(target.channel)) return { url: link.url, message: null, snapshot: null, unavailable: 'not_readable' }
    return { url: link.url, message: ref(link.message), snapshot: link.snapshot ?? null, unavailable: link.unavailable ?? null }
  }

  /** A message the caller may read, by its ref, or 404 as if it weren't there. */
  readable(id: string, access: Access): MessageRow {
    const row = /^(0|[1-9]\d{0,15})$/.test(id) && id !== '0' ? this.message(Number(id)) : null
    if (!row || !access.readable(row.channel)) throw notFound('message not found: #' + id, 'message_not_found')
    return row
  }
}

/** The labels a filter sees on a root, with its task's state as board.task. */
function withTask(board: Board, row: MessageRow, labels: Record<string, string>): Record<string, string> {
  if (row.re !== null || row.deleted) return labels
  const task = board.sql.one<{ state: string }>('select state from tasks where root = ?', row.id)
  return task ? { ...labels, 'board.task': task.state } : labels
}

export const cursorOf = (value: string): number => {
  if (!/^(0|[1-9]\d{0,15})$/.test(value)) throw new WorkbusError(400, 'invalid_cursor', value + " isn't a cursor or a message ID on this board")
  return Number(value)
}

export { canMap, decide }
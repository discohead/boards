// Grants: who the board lets in, and what each may do where. Every grant write is judged by the rule
// the protocol names checkGrantChange (reach, admission, lockout) on the grants as they are and as the
// write would leave them, in the write's own transaction, so nothing outruns it. Grants are side facts:
// they live in the grants table, never in the board log, and every change bumps the grants version.
import { WorkbusError, badRequest, forbidden, notFound } from '../errors.ts'
import { expand, PERMISSIONS, wirePermissions, type Grant, type Permission } from './access.ts'
import { iso, levelOf, partyTo, type Caller, type GrantPrincipal, type Principal, type StoredGrant } from './core.ts'
import { op, type Ctx } from './ops.ts'

const GITHUB_ISSUER = 'https://token.actions.githubusercontent.com'
const CHANNEL = /^[a-z0-9][a-z0-9_-]*(?:\/[a-z0-9][a-z0-9_-]*)*$/
const GRANT_ID = /^g([1-9]\d{0,15})$/
const PRINCIPALS_MAX = 32
const PATTERNS_MAX = 64
const ENVIRONMENTS = ['production', 'preview', 'development']
/** A Worker's script name: what a project (or worker) principal names here. */
const SCRIPT = /^[a-z0-9][a-z0-9_-]{0,62}$/
const LEVELS = ['principal', 'group', 'everyone'] as const

const invalidGrant = (message: string) => new WorkbusError(400, 'invalid_grant', message)

// ---------------------------------------------------------------------------------------------
// Access as a map: each pattern to what it gives (implications closed), resolved per channel by
// the most specific pattern that covers it.

export type AccessMap = Record<string, Permission[]>
const FULL: AccessMap = { '*': [...PERMISSIONS] }

/** How specific a pattern is for a channel it covers, higher is more; null when it doesn't. */
function covers(pattern: string, channel: string, exact = true): number | null {
  if (pattern === '*') return 0
  if (pattern.endsWith('/')) {
    const path = pattern.slice(0, -1)
    return channel === path || channel.startsWith(path + '/') ? 1 + path.length : null
  }
  return exact && pattern === channel ? Number.MAX_SAFE_INTEGER : null
}

function best(map: AccessMap, channel: string, exact: boolean): Permission[] {
  let at = -1
  let out: Permission[] = []
  for (const [pattern, permissions] of Object.entries(map)) {
    const specificity = covers(pattern, channel, exact)
    if (specificity !== null && specificity > at) (at = specificity), (out = permissions)
  }
  return out
}

/** What a map gives in a channel. */
export const resolve = (map: AccessMap, channel: string): Permission[] => best(map, channel, true)

/** What a map gives where a pattern itself decides: at *, the * rule; at x/, x ignoring an exact rule for it. */
export function at(map: AccessMap, pattern: string): Permission[] {
  if (pattern === '*') return map['*'] ?? []
  if (pattern.endsWith('/')) return best(map, pattern.slice(0, -1), false)
  return resolve(map, pattern)
}

const order = (permissions: Iterable<Permission>) => {
  const set = new Set(permissions)
  return PERMISSIONS.filter((permission) => set.has(permission))
}

/** The intersection, pattern by pattern: never wider than either side. */
export function narrowMap(a: AccessMap, b: AccessMap): AccessMap {
  const out: AccessMap = {}
  for (const pattern of new Set(['*', ...Object.keys(a), ...Object.keys(b)])) {
    const there = new Set(at(b, pattern))
    out[pattern] = at(a, pattern).filter((permission) => there.has(permission))
  }
  return out
}

export const mapOf = (can: Readonly<Record<string, Grant>>): AccessMap => Object.fromEntries(Object.entries(can).map(([pattern, grant]) => [pattern, expand(grant)]))

/** The canonical summary's patterns: a rule equal to its parent goes, and an empty *. */
function canonicalPatterns(map: AccessMap): string[] {
  const out: string[] = []
  const same = (x: Permission[], y: Permission[]) => x.length === y.length && x.every((permission, i) => permission === y[i])
  for (const [pattern, permissions] of Object.entries(map)) {
    if (pattern === '*') {
      if (permissions.length) out.push(pattern)
      continue
    }
    const rest = { ...map }
    delete rest[pattern]
    const parent = pattern.endsWith('/') ? at(rest, pattern) : at(rest, pattern + '/')
    if (!same(order(permissions), order(parent))) out.push(pattern)
  }
  return out
}

type Match = { grant: StoredGrant; level: 0 | 1 | 2 }

/** The grants that name a principal, each at the closest level one of its principals does. */
function matchesFor(grants: StoredGrant[], principal: Principal, withoutEveryone: boolean): Match[] {
  const out: Match[] = []
  for (const grant of grants) {
    let level: 0 | 1 | 2 | null = null
    for (const named of grant.principals) {
      if (withoutEveryone && named.kind === 'everyone') continue
      const found = levelOf(named, principal)
      if (found !== null && (level === null || found < level)) level = found
    }
    if (level !== null) out.push({ grant, level })
  }
  return out
}

/** Per pattern, the closest level wins and its grants add up. */
function combine(matches: Match[]): AccessMap {
  const best: Record<string, { level: number; permissions: Set<Permission> }> = {}
  for (const { grant, level } of matches)
    for (const [pattern, given] of Object.entries(grant.can)) {
      const current = best[pattern]
      if (!current || level < current.level) best[pattern] = { level, permissions: new Set(expand(given)) }
      else if (level === current.level) for (const permission of expand(given)) current.permissions.add(permission)
    }
  return Object.fromEntries(Object.entries(best).map(([pattern, { permissions }]) => [pattern, order(permissions)]))
}

const VIEWER_CAP: AccessMap = { '*': ['read', 'react'] }

/** A principal's access on some grants: caller with every grant, own without everyone's; null when nothing lets it in. */
export function grantAccess(grants: StoredGrant[], caller: Pick<Caller, 'principal' | 'narrow'>): { caller: AccessMap; own: AccessMap } | null {
  const { principal } = caller
  const scope = (map: AccessMap) => {
    let out = principal.role === 'viewer' ? narrowMap(map, VIEWER_CAP) : map
    if (caller.narrow) out = narrowMap(out, mapOf(caller.narrow))
    return out
  }
  if (principal.own) return { caller: scope(FULL), own: scope(FULL) }
  const all = matchesFor(grants, principal, false)
  if (!(principal.kind === 'person' || all.some((match) => match.level < 2))) return null
  return { caller: scope(combine(all)), own: scope(combine(matchesFor(grants, principal, true))) }
}

// ---------------------------------------------------------------------------------------------
// Who may change grants, and checkGrantChange.

/** An owner: the board's own code, or a person whose token says owner. Judged by its x-board-can alone, if any. */
const isOwner = (ctx: Ctx) => Boolean(ctx.caller.principal.own || ctx.caller.principal.role === 'owner')

type Standing = { caller: AccessMap; own: AccessMap }

function standingOf(ctx: Ctx, grants: StoredGrant[]): Standing | 'owner' | null {
  if (isOwner(ctx)) {
    if (!ctx.caller.narrow) return 'owner'
    const can = mapOf(ctx.caller.narrow)
    return { caller: can, own: can }
  }
  return grantAccess(grants, ctx.caller)
}

/** Whether the caller may list grants and explain others: manage at *, or an owner whose x-board-can leaves it that. */
export function mayList(ctx: Ctx, grants = ctx.board.grants()): boolean {
  const standing = standingOf(ctx, grants)
  if (standing === 'owner') return true
  return standing !== null && at(standing.caller, '*').includes('manage')
}

type Refusal = { reason: 'reach' | 'admission' | 'lockout'; pattern: string; permission: Permission }
type Change = { caller: AccessMap; own: AccessMap; then?: Standing; after: StoredGrant[]; changed?: { can: Record<string, Grant> }; revoked?: { can: Record<string, Grant> } }

const isUnder = (spot: string, pattern: string) => spot !== pattern && (pattern === '*' || (pattern.endsWith('/') && (spot === pattern.slice(0, -1) || spot.startsWith(pattern))))
const unique = (values: string[]) => [...new Set(values)]

/** The rule a grant change must pass, exactly as the protocol writes it: null when it's allowed. */
export function checkGrantChange(change: Change): Refusal | null {
  const { caller, own, then, after } = change
  const everyone = after.filter((grant) => grant.principals.some((named) => named.kind === 'everyone'))
  const lifted = change.revoked ? Object.keys(change.revoked.can) : []
  const made = change.changed ? Object.keys(change.changed.can) : []
  const touched = unique([...lifted, ...made])
  const spots = unique([...touched, ...everyone.flatMap((grant) => Object.keys(grant.can)), ...canonicalPatterns(caller), ...canonicalPatterns(own)])
  for (const pattern of touched) {
    if (!at(caller, pattern).includes('manage') || !at(own, pattern).includes('manage')) return { reason: 'reach', pattern, permission: 'manage' }
    for (const spot of spots) if (isUnder(spot, pattern) && !at(own, spot).includes('manage')) return { reason: 'reach', pattern: spot, permission: 'manage' }
  }
  if (made.length) {
    const gives = combine(everyone.map((grant) => ({ grant, level: 2 as const })))
    for (const spot of spots)
      for (const permission of PERMISSIONS) if (at(gives, spot).includes(permission) && !at(caller, spot).includes(permission)) return { reason: 'admission', pattern: spot, permission }
  }
  if (then)
    for (const pattern of touched)
      if (!at(then.caller, pattern).includes('manage') || !at(then.own, pattern).includes('manage')) return { reason: 'lockout', pattern, permission: 'manage' }
  return null
}

type Form = { what: string; doing: string; revokes: boolean }
const LOCKOUT_HINT = 'Name yourself with manage there, in a grant made before it or in the same write. Or send lockMeOut to go ahead: only someone who still manages grants there could change it then.'

/** A refusal as the protocol answers it: a stored grant's patterns only to a caller that may list. */
function refusal(found: Refusal, form: Form, listing: boolean): WorkbusError {
  if (found.reason === 'admission') return forbidden("you can't let anyone in: everyone gets " + found.permission + ' in ' + found.pattern + ", which you can't")
  if (found.reason === 'lockout') {
    const where = form.revokes && !listing ? 'where it reaches' : 'in ' + found.pattern
    return new WorkbusError(409, 'grant_lockout', form.doing + ' would leave you unable to manage grants ' + where, { hint: LOCKOUT_HINT })
  }
  if (form.revokes) return forbidden(listing ? "this token can't " + form.what + ': it reaches ' + found.pattern + ", where you can't manage grants" : "this token can't " + form.what + ': it needs manage wherever that grant reaches')
  return forbidden(form.what + ' reaches ' + found.pattern + ", where you can't manage grants")
}

const nothingHere = () => forbidden("this token can't change grants: it may do nothing on this board")

/** Judges one change for the caller; throws its refusal. then is the standing after, or null for lockMeOut. */
function judge(ctx: Ctx, standing: Standing | 'owner' | null, then: Standing | null, after: StoredGrant[], change: Pick<Change, 'changed' | 'revoked'>, form: Form, listing: boolean) {
  if (standing === 'owner') return
  if (standing === null) throw nothingHere()
  const found = checkGrantChange({ caller: standing.caller, own: standing.own, ...(then ? { then } : {}), after, ...change })
  if (found) throw refusal(found, form, listing)
}

/** The standing on the grants a write would leave, for lockout: no access counts as none. */
function thenOf(ctx: Ctx, grants: StoredGrant[], lockMeOut: boolean | undefined): Standing | null {
  if (lockMeOut) return null
  const standing = standingOf(ctx, grants)
  if (standing === 'owner') return null
  return standing ?? { caller: {}, own: {} }
}

const OIDC_FORM: Form = { what: 'naming an oidc issuer', doing: 'naming an oidc issuer', revokes: false }
const EVERYTHING = { can: { '*': 'all' as const } }

// ---------------------------------------------------------------------------------------------
// Principals and cans, as a board that verifies tokens itself keeps them.

type Input = Record<string, unknown> & { kind: string }

const envOrder = (a: string, b: string) => {
  const ia = ENVIRONMENTS.indexOf(a)
  const ib = ENVIRONMENTS.indexOf(b)
  if (ia >= 0 || ib >= 0) return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib)
  return a.localeCompare(b)
}
const environmentsOf = (values: unknown) => [...new Set((values as string[]).map(String))].sort(envOrder)

/** An issuer's name: host and path, as a principal ID writes it. Two issuers with one name name the same principals. */
function issuerName(issuer: string): string {
  const url = new URL(issuer)
  return (url.host + url.pathname.replace(/\/+$/, '')).replace(/[%:]/g, (char) => (char === '%' ? '%25' : '%3A'))
}

const LOCAL_HOST = /^(?:\d+|\d{1,3}(?:\.\d{1,3}){3})$/
const PRIVATE_SUFFIX = ['.localhost', '.local', '.internal', '.home', '.lan', '.corp', '.intranet']

function checkIssuer(issuer: string, ctx: Ctx, issuers: string[]): void {
  let url: URL
  try {
    url = new URL(issuer)
  } catch {
    throw invalidGrant("an oidc principal's issuer is an https URL, got " + issuer)
  }
  if (issuer.replace(/\/+$/, '') === GITHUB_ISSUER) throw invalidGrant('name GitHub Actions runs as a github principal, not as an oidc issuer')
  if (issuer.replace(/\/+$/, '') === ctx.mount.origin.replace(/\/+$/, '') + '/issuer') throw invalidGrant("name this board's own people as user principals and its Workers as worker principals, not as an oidc issuer")
  if (url.protocol !== 'https:' || url.search !== '' || url.hash !== '' || issuer.includes('#') || issuer.includes('?') || url.username !== '' || url.password !== '')
    throw invalidGrant("an oidc principal's issuer is an https URL with no query or credentials, got " + issuer)
  const host = url.hostname.toLowerCase().replace(/\.$/, '')
  if (host.startsWith('[') || LOCAL_HOST.test(host) || !host.includes('.') || host === 'localhost' || PRIVATE_SUFFIX.some((suffix) => host.endsWith(suffix)))
    throw invalidGrant("an oidc principal's issuer is on the internet, not " + url.hostname)
  const name = issuerName(issuer)
  for (const other of issuers) if (other !== issuer && issuerName(other) === name) throw invalidGrant('issuers ' + other + ' and ' + issuer + ' name the same principals, oidc:' + name + ':<sub>: use ' + other)
}

/** A principal input as the board keeps it, or 400 invalid_grant. A removal names a project without environments. */
function checkPrincipal(ctx: Ctx, input: Input, issuers: string[], removal = false): GrantPrincipal {
  switch (input.kind) {
    case 'user': {
      const { email, userId } = input as { email?: string; userId?: string }
      if (email !== undefined && userId !== undefined) throw invalidGrant('a user is its email or its userId, not both')
      const named = email ?? userId
      if (named !== undefined && named.includes('@')) {
        const login = named.toLowerCase()
        if (!/^[^\s@:]{1,64}@[a-z0-9][a-z0-9.-]{0,252}$/.test(login)) throw invalidGrant("a user here is the email they sign in with, like ada@example.com, got " + named)
        return { kind: 'user', userId: login, email: login }
      }
      if (named === undefined || !/^[A-Za-z0-9][A-Za-z0-9_.-]{0,199}$/.test(named)) throw invalidGrant('a user is its userId, letters, numbers, and ._-')
      return { kind: 'user', userId: named }
    }
    case 'project': {
      const project = String(input.project)
      if (!SCRIPT.test(project)) throw invalidGrant("a project here is one of the account's Workers, by its script name (lowercase letters, numbers, - and _), got " + project)
      if (removal) return { kind: 'project', projectId: project }
      if (input.environments === undefined) throw invalidGrant("a project names the environments its deployments get in from, like ['production']")
      return { kind: 'project', projectId: project, environments: environmentsOf(input.environments) }
    }
    case 'worker': {
      const script = String(input.script)
      if (!SCRIPT.test(script)) throw invalidGrant("a worker is one of the account's Workers, by its script name (lowercase letters, numbers, - and _), got " + script)
      return { kind: 'worker', script }
    }
    case 'all-projects': {
      if (removal) return { kind: 'all-projects' }
      if (input.environments === undefined) throw invalidGrant("all-projects names the environments its deployments get in from, like ['production']")
      const environments = environmentsOf(input.environments)
      for (const environment of environments) if (!ENVIRONMENTS.includes(environment)) throw invalidGrant('all-projects names production, preview, or development: ' + environment + " is one project's")
      return { kind: 'all-projects', environments }
    }
    case 'github': {
      const repository = String(input.repository)
      if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository)) throw invalidGrant("a github principal's repository is owner/name, got " + repository)
      const out: GrantPrincipal = { kind: 'github', repository }
      if (input.workflow !== undefined) out.workflow = String(input.workflow).includes('/') ? String(input.workflow) : '.github/workflows/' + String(input.workflow)
      if (input.branch !== undefined) out.branch = String(input.branch).replace(/^refs\/heads\//, '')
      if (input.event !== undefined) out.event = String(input.event)
      return out
    }
    case 'oidc': {
      const issuer = String(input.issuer)
      checkIssuer(issuer, ctx, issuers)
      const claims = (input.claims ?? {}) as Record<string, string | string[]>
      const names = Object.keys(claims)
      if (names.length === 0) throw invalidGrant('name at least one claim for ' + issuer + ': its issuer signs tokens for everyone it serves')
      if (names.length > 32) throw invalidGrant('an oidc principal names at most 32 claims')
      const kept: Record<string, string | string[]> = {}
      for (const name of names.sort()) {
        const value = claims[name]!
        const values = Array.isArray(value) ? value : [value]
        if (values.length === 0 || values.some((item) => typeof item !== 'string' || item === '')) throw invalidGrant('claim ' + name + ' has no value to match: give a string, or a list of them')
        if (values.length > 32 || values.some((item) => item.length > 1000)) throw invalidGrant('claim ' + name + ' lists at most 32 values of up to 1000 characters')
        const sorted = [...new Set(values)].sort()
        kept[name] = sorted.length === 1 ? sorted[0]! : sorted
      }
      return { kind: 'oidc', issuer, claims: kept }
    }
    case 'app': {
      const app = String(input.app)
      if (!/^[A-Za-z0-9][A-Za-z0-9_.-]{0,199}$/.test(app)) throw invalidGrant('an app is its client ID, letters, numbers, and ._-, got ' + app)
      return { kind: 'app', clientId: app }
    }
    case 'all-users':
    case 'all-workers':
    case 'all-apps':
    case 'everyone':
      return { kind: input.kind }
    default:
      throw invalidGrant('unknown principal kind ' + input.kind)
  }
}

const issuersOf = (grants: StoredGrant[]) => unique(grants.flatMap((grant) => grant.principals.filter((named) => named.kind === 'oidc').map((named) => String(named.issuer))))

/** A grant's principals: each checked, deduplicated by their JSON, 1 to 32. */
function checkPrincipals(ctx: Ctx, inputs: Input[], issuers: string[]): GrantPrincipal[] {
  const out: GrantPrincipal[] = []
  const seen = new Set<string>()
  const known = [...issuers]
  for (const input of inputs) {
    const kept = checkPrincipal(ctx, input, known)
    if (kept.kind === 'oidc') known.push(String(kept.issuer))
    const key = JSON.stringify(kept)
    if (!seen.has(key)) seen.add(key), out.push(kept)
  }
  if (out.length === 0) throw invalidGrant('a grant names at least one principal')
  if (out.length > PRINCIPALS_MAX) throw invalidGrant('a grant names at most 32 principals')
  return out
}

function checkPattern(pattern: string): void {
  if (pattern === '*') return
  const star = pattern.indexOf('*')
  if (star >= 0) {
    const before = pattern.slice(0, star).replace(/\/+$/, '')
    const hint = before === '' ? 'write * for every channel' : CHANNEL.test(before) && before.length <= 2048 ? 'write ' + before + '/ for ' + before + ' and its subtree' : 'write *, a channel, or a channel and its subtree (feedback/)'
    throw invalidGrant('invalid channel pattern ' + pattern + ': ' + hint)
  }
  const path = pattern.endsWith('/') ? pattern.slice(0, -1) : pattern
  if (!CHANNEL.test(path) || path.length > 2048) throw invalidGrant('invalid channel pattern ' + (pattern || '(empty)') + ': write *, a channel, or a channel and its subtree (feedback/)')
}

/** A can as written: every pattern kept (an empty list too), lists in canonical order, * first then by localeCompare. */
export function writtenCan(can: unknown): Record<string, Grant> {
  if (can === null || typeof can !== 'object' || Array.isArray(can)) throw invalidGrant("a grant's can is a map from channel pattern to permissions, like { 'ci/': ['read', 'post'] }")
  const entries = Object.entries(can as Record<string, unknown>)
  if (entries.length === 0) throw invalidGrant("a grant's can names at least one channel pattern, like { '*': ['read'] }")
  if (entries.length > PATTERNS_MAX) throw invalidGrant("a grant's can names at most 64 channel patterns")
  const out: Record<string, Grant> = {}
  const keys = entries.map(([pattern]) => pattern).sort((a, b) => (a === '*' ? -1 : b === '*' ? 1 : a.localeCompare(b)))
  for (const pattern of keys) {
    checkPattern(pattern)
    const value = (can as Record<string, unknown>)[pattern]
    if (value === 'all') {
      out[pattern] = 'all'
      continue
    }
    if (!Array.isArray(value)) throw invalidGrant(pattern + " takes 'all' or a list of permissions: " + PERMISSIONS.join(', '))
    for (const permission of value)
      if (!(PERMISSIONS as readonly unknown[]).includes(permission)) throw invalidGrant('unknown permission ' + String(permission) + ' at ' + pattern + ': use ' + PERMISSIONS.join(', ') + ', or all')
    out[pattern] = order(value as Permission[])
  }
  return out
}

// ---------------------------------------------------------------------------------------------
// Views.

export function principalView(named: GrantPrincipal): Record<string, unknown> {
  switch (named.kind) {
    case 'user':
      return { kind: 'user', userId: String(named.userId ?? named.id ?? ''), email: typeof named.email === 'string' ? named.email : null }
    case 'project':
      return { kind: 'project', projectId: String(named.projectId), name: null, environments: (named.environments as string[]) ?? [], teamId: null }
    case 'worker':
      return { kind: 'worker', script: String(named.script ?? named.worker) }
    case 'github': {
      const out: Record<string, unknown> = { kind: 'github', repository: named.repository }
      for (const key of ['workflow', 'branch', 'event']) if (named[key] !== undefined) out[key] = named[key]
      out.repositoryId = named.repositoryId === undefined ? null : String(named.repositoryId)
      return out
    }
    case 'oidc':
      return { kind: 'oidc', issuer: named.issuer, claims: named.claims ?? {} }
    case 'all-projects':
      return { kind: 'all-projects', environments: (named.environments as string[]) ?? [] }
    case 'app':
      return { kind: 'app', clientId: String(named.clientId), name: null }
    default:
      return { kind: named.kind }
  }
}

export function grantView(grant: StoredGrant) {
  const starting = grant.at === 0
  return { id: grant.id, principals: grant.principals.map(principalView), can: grant.can, capped: false, by: starting ? null : grant.by, at: starting ? null : iso(grant.at) }
}

// ---------------------------------------------------------------------------------------------
// Storage.

function nextNumber(ctx: Ctx): number {
  const top = ctx.sql.one<{ n: number | null }>('select max(n) as n from grants')?.n ?? 0
  return Math.max(3, top) + 1
}

function store(ctx: Ctx, grant: StoredGrant, revoked = false) {
  ctx.sql.run(
    'insert into grants (id, n, principals, can, by, at, revoked) values (?, ?, ?, ?, ?, ?, ?) on conflict (id) do update set principals = excluded.principals, can = excluded.can, by = excluded.by, at = excluded.at, revoked = excluded.revoked',
    grant.id, grant.n, JSON.stringify(grant.principals), JSON.stringify(grant.can), grant.by, grant.at, revoked ? 1 : 0,
  )
}

const find = (grants: StoredGrant[], id: string) => (GRANT_ID.test(id) ? grants.find((grant) => grant.id === id) ?? null : null)

// ---------------------------------------------------------------------------------------------
// Operations.

op('grants', (ctx) => {
  const grants = ctx.board.grants()
  if (!mayList(ctx, grants)) throw forbidden("this token can't list grants: it needs manage at *")
  return { grants: grants.map(grantView) }
}, { read: true })

type GrantInput = { principals: Input[]; can: Record<string, Grant> }

/** Makes grants in one write: validated first, judged with all of them made, stored in the order given. */
function makeGrants(ctx: Ctx, inputs: GrantInput[], lockMeOut: boolean | undefined): StoredGrant[] {
  const before = ctx.board.grants()
  const issuers = issuersOf(before)
  let n = nextNumber(ctx)
  const made: StoredGrant[] = []
  for (const input of inputs) {
    const principals = checkPrincipals(ctx, input.principals, issuers)
    for (const named of principals) if (named.kind === 'oidc') issuers.push(String(named.issuer))
    const can = writtenCan(input.can)
    made.push({ id: 'g' + n, n, principals, can, by: ctx.actor.id, at: ctx.now })
    n++
  }
  const standing = standingOf(ctx, before)
  if (standing === null) throw nothingHere()
  const after = [...before, ...made]
  const then = thenOf(ctx, after, lockMeOut)
  const listing = mayList(ctx, before)
  made.forEach((grant, i) => {
    const name = made.length > 1 ? 'grant ' + (i + 1) + ' of ' + made.length : 'this grant'
    judge(ctx, standing, then, after, { changed: grant }, { what: name, doing: name, revokes: false }, listing)
    if (grant.principals.some((named) => named.kind === 'oidc')) judge(ctx, standing, null, after, { changed: EVERYTHING }, OIDC_FORM, listing)
  })
  for (const grant of made) store(ctx, grant)
  ctx.board.bumpGrants()
  return made
}

op('createGrant', (ctx, body: GrantInput & { lockMeOut?: boolean }) => {
  const [grant] = makeGrants(ctx, [body], body.lockMeOut)
  return { grant: grantView(grant!) }
})

op('createGrants', (ctx, body: { grants: GrantInput[]; lockMeOut?: boolean }) => ({ grants: makeGrants(ctx, body.grants, body.lockMeOut).map(grantView) }))

/** Whether a removal names a principal the grant keeps. */
function removes(removal: GrantPrincipal, kept: GrantPrincipal): boolean {
  if (removal.kind !== kept.kind) return false
  switch (removal.kind) {
    case 'user':
      return String(kept.userId).toLowerCase() === String(removal.userId).toLowerCase()
    case 'project':
      return kept.projectId === removal.projectId
    case 'worker':
      return kept.script === removal.script
    case 'github':
      return String(kept.repository).toLowerCase() === String(removal.repository).toLowerCase() && ['workflow', 'branch', 'event'].every((key) => removal[key] === undefined || removal[key] === kept[key])
    case 'oidc':
      return kept.issuer === removal.issuer && JSON.stringify(kept.claims) === JSON.stringify(removal.claims)
    case 'app':
      return kept.clientId === removal.clientId
    default:
      return true
  }
}

op('updateGrant', (ctx, body: { id: string; add?: Input[]; remove?: Input[]; can?: Record<string, Grant>; lockMeOut?: boolean }) => {
  const before = ctx.board.grants()
  const listing = mayList(ctx, before)
  const grant = find(before, body.id)
  if (!grant) throw listing ? notFound('grant not found: ' + body.id, 'grant_not_found') : forbidden("this token can't update " + body.id + ': it needs manage wherever that grant reaches')
  const form: Form = { what: 'update ' + grant.id, doing: 'updating ' + grant.id, revokes: true }
  const standing = standingOf(ctx, before)
  // Whom it names is news only to someone who may change it.
  judge(ctx, standing, null, before, { revoked: grant }, form, listing)
  let principals = [...grant.principals]
  for (const input of body.remove ?? []) {
    const removal = checkPrincipal(ctx, input, [], true)
    const left = principals.filter((kept) => !removes(removal, kept))
    if (left.length === principals.length) throw badRequest(grant.id + " doesn't name that " + removal.kind + ' principal', 'not_in_grant')
    principals = left
  }
  const others = before.filter((other) => other.id !== grant.id)
  const issuers = issuersOf([...others, grant])
  const addedOidc: GrantPrincipal[] = []
  for (const input of body.add ?? []) {
    const kept = checkPrincipal(ctx, input, issuers)
    if (kept.kind === 'oidc') issuers.push(String(kept.issuer))
    const joins = principals.findIndex((named) => (kept.kind === 'project' && named.kind === 'project' && named.projectId === kept.projectId) || (kept.kind === 'all-projects' && named.kind === 'all-projects'))
    if (joins >= 0) {
      const named = principals[joins]!
      principals[joins] = { ...named, environments: environmentsOf([...((named.environments as string[]) ?? []), ...(kept.environments as string[])]) }
      continue
    }
    if (principals.some((named) => JSON.stringify(named) === JSON.stringify(kept))) continue
    principals.push(kept)
    if (kept.kind === 'oidc' && !grant.principals.some((named) => JSON.stringify(named) === JSON.stringify(kept))) addedOidc.push(kept)
  }
  if (principals.length === 0) throw badRequest('that leaves ' + grant.id + ' naming no one: revoke it instead', 'grant_empty')
  if (principals.length > PRINCIPALS_MAX) throw invalidGrant('a grant names at most 32 principals')
  const can = body.can !== undefined ? writtenCan(body.can) : grant.can
  const updated: StoredGrant = { ...grant, principals, can, by: ctx.actor.id, at: ctx.now }
  const after = [...others, updated].sort((a, b) => a.n - b.n)
  const widens = body.add !== undefined || body.can !== undefined
  judge(ctx, standing, thenOf(ctx, after, body.lockMeOut), after, { revoked: grant, ...(widens ? { changed: updated } : {}) }, form, listing)
  if (addedOidc.length) judge(ctx, standing, null, after, { changed: EVERYTHING }, OIDC_FORM, listing)
  store(ctx, updated)
  ctx.board.bumpGrants()
  return { grant: grantView(updated) }
})

op('revokeGrant', (ctx, body: { id: string; lockMeOut?: boolean }) => {
  const before = ctx.board.grants()
  const listing = mayList(ctx, before)
  const grant = find(before, body.id)
  if (!grant) {
    if (listing) return { revoked: false }
    throw forbidden("this token can't revoke " + body.id + ': it needs manage wherever that grant reaches')
  }
  const after = before.filter((other) => other.id !== grant.id)
  judge(ctx, standingOf(ctx, before), thenOf(ctx, after, body.lockMeOut), after, { revoked: grant }, { what: 'revoke ' + grant.id, doing: 'revoking ' + grant.id, revokes: true }, listing)
  store(ctx, { ...grant, by: ctx.actor.id, at: ctx.now }, true)
  ctx.board.bumpGrants()
  return { revoked: true }
})

// ---------------------------------------------------------------------------------------------
// Explain: what decides a channel for a principal, built as a token of its would be.

type ExplainQuery = { channel: string; user?: string; project?: string; environment?: string; worker?: string; github?: string; workflow?: string; branch?: string; event?: string; oidc?: string; claim?: string | string[]; app?: string }

const principal = (id: string, kind: Principal['kind'], name: string, issuer: string, claims: Record<string, unknown>, extra: Partial<Principal> = {}): Principal => ({ id, kind, handle: name, name, facts: { issuer, claims }, expiresAt: null, ...extra })

/** The principal a query names, as a token of its would be; 'app' when it names an app, which nothing lets in here. */
function namedPrincipal(query: ExplainQuery): Principal | 'app' {
  if (query.user !== undefined) {
    if (query.user.includes('@')) {
      const email = query.user.toLowerCase()
      return principal('access:' + email, 'person', email, 'access', { sub: email, email }, { role: 'member' })
    }
    return principal('workbus:user:' + query.user, 'person', query.user, 'workbus', { sub: query.user }, { role: 'member' })
  }
  const worker = query.project ?? query.worker
  if (worker !== undefined) {
    if (!SCRIPT.test(worker)) throw badRequest("this board can't look up the Worker " + worker + ': name it by its script name, lowercase letters, numbers, - and _')
    return principal('worker:' + worker, 'deployment', worker, 'workbus', { sub: worker, kind: 'workload', environment: query.environment ?? 'production' })
  }
  if (query.github !== undefined) {
    const branch = query.branch ?? 'main'
    const claims: Record<string, unknown> = { repository: query.github, ref: 'refs/heads/' + branch }
    if (query.workflow !== undefined) claims.workflow_ref = query.github + '/' + (query.workflow.includes('/') ? query.workflow : '.github/workflows/' + query.workflow) + '@refs/heads/' + branch
    if (query.event !== undefined) claims.event_name = query.event
    return principal('github:repo:' + query.github, 'workflow', query.github, 'github', claims)
  }
  if (query.oidc !== undefined) {
    let ok = false
    try {
      ok = new URL(query.oidc).protocol === 'https:'
    } catch {}
    if (!ok) throw badRequest('an oidc issuer is an https URL, got ' + query.oidc)
    const claims: Record<string, unknown> = {}
    for (const pair of query.claim === undefined ? [] : Array.isArray(query.claim) ? query.claim : [query.claim]) {
      const split = pair.indexOf('=')
      if (split <= 0) throw badRequest("a claim is name=value, and " + pair + " isn't one")
      claims[pair.slice(0, split)] = pair.slice(split + 1)
    }
    return principal('oidc:' + issuerName(query.oidc) + ':' + String(claims.sub ?? ''), 'workflow', String(claims.sub ?? query.oidc), query.oidc, claims)
  }
  return 'app'
}

op('explainGrants', (ctx, query: ExplainQuery) => {
  const grants = ctx.board.grants()
  const listing = mayList(ctx, grants)
  const nobody = { channel: query.channel, pattern: null, over: [], level: null, grants: [], capped: null, can: [] as Permission[] }
  const naming = [query.user, query.project, query.worker, query.github, query.oidc, query.app].some((value) => value !== undefined)
  let who: Pick<Caller, 'principal' | 'narrow'>
  if (naming) {
    if (!listing) throw forbidden("this token can't explain what another principal may do: it needs manage at *")
    const named = namedPrincipal(query)
    if (named === 'app') return nobody
    who = { principal: named, narrow: null }
  } else who = { principal: ctx.caller.principal, narrow: ctx.caller.narrow }
  // A private channel gives a non-party nothing, whatever its grants say (design/private-channels.md).
  const parties = ctx.board.partiesOf(query.channel)
  if (parties && !(who.principal.own && !who.principal.outsider) && !partyTo(parties, { ...who, profile: naming ? null : ctx.caller.profile, via: ctx.caller.via })) return nobody
  const scope = (permissions: Permission[]) => wirePermissions(who.narrow ? permissions.filter((permission) => resolve(mapOf(who.narrow!), query.channel).includes(permission)) : permissions) as Permission[]
  if (who.principal.own) return { ...nobody, can: scope([...PERMISSIONS]) }
  const matches = matchesFor(grants, who.principal, false)
  if (!(who.principal.kind === 'person' || matches.some((match) => match.level < 2))) return nobody
  const byPattern = new Map<string, { level: number; grants: StoredGrant[] }>()
  for (const { grant, level } of matches)
    for (const pattern of Object.keys(grant.can)) {
      const current = byPattern.get(pattern)
      if (!current || level < current.level) byPattern.set(pattern, { level, grants: [grant] })
      else if (level === current.level && !current.grants.includes(grant)) current.grants.push(grant)
    }
  const covering = [...byPattern.keys()].filter((pattern) => covers(pattern, query.channel) !== null).sort((a, b) => covers(b, query.channel)! - covers(a, query.channel)!)
  if (covering.length === 0) return nobody
  const winner = covering[0]!
  const decided = byPattern.get(winner)!
  const given = order(decided.grants.flatMap((grant) => expand(grant.can[winner]!)))
  const viewer = who.principal.role === 'viewer'
  const capped = viewer ? given.filter((permission) => permission === 'read' || permission === 'react') : given
  return {
    channel: query.channel,
    pattern: winner,
    over: covering.slice(1),
    level: LEVELS[decided.level],
    grants: listing ? decided.grants.map(grantView) : [],
    capped: viewer && capped.length < given.length ? 'viewer' : null,
    can: scope(capped),
  }
}, { read: true })

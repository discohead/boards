// Sync's records: what platforms wrote here (imports, as their authors), what sync did there
// (receipts), where each thread syncs, the copies of its messages, and the inbox a sync pulls its
// platform events from, one platform thread at a time. A sync is the board's own (its deployment
// declares it: an Inbox and a courier per key, src/sync/) or a registrant (watchers.ts), whose entries
// say which platform users it speaks for.
import { badRequest, BoardsError, conflict, forbidden, notFound } from '../errors.ts'
import { accessOf } from './access.ts'
import { iso, ref, type ActorRecord, type MessageRow } from './core.ts'
import { byOf, deleteMessage, editMessage, labelMessage, MESSAGE_TEXT_MAX, postMessage, reactTo, refuseReserved } from './messages.ts'
import { hooks, op, OPS, viewOptions, type Ctx } from './ops.ts'
import { linkTargets } from '../sync/links.ts'
import { payloadView } from './feed.ts'
import { json } from './sql.ts'
import { prose } from './text.ts'
import { backoff, derivedId, entriesOf, LEASE_MS, leaseId, ownSyncKeys, sha256, TRIES, type SyncEntry } from './watchers.ts'

// -- tables of sync's own --------------------------------------------------------------------------

const ready = new WeakSet<object>()
/** Who recorded each copy, and the files its receipt said: sync_copies has no columns for them. */
function tables(ctx: Pick<Ctx, 'sql'>) {
  if (ready.has(ctx.sql)) return
  ctx.sql.run('create table if not exists sync_copy_marks (message integer not null, target text not null, by text, files text, primary key (message, target)) strict, without rowid')
  ready.add(ctx.sql)
}

// -- shapes ---------------------------------------------------------------------------------------

export const keyOf = (target: string) => target.slice(0, target.indexOf(':'))
export const kindOf = (target: string): 'channel' | 'thread' => (target.slice(target.indexOf(':') + 1).includes(':') ? 'thread' : 'channel')

type PlatformUser = { id: string; handle: string; name: string; avatar: string | null; isBot: boolean }
type Origin = { channel?: string; thread: string; subthread: string | null; message: string; context: string | null }
type ImportOrigin = { thread: string; message?: string }
type ImportLink = { url: string; message: string | null; snapshot: unknown; unavailable: string | null }
type Source = { key: string; channel: string; thread: string }

const unnarrowed = (ctx: Ctx, what: string) => {
  if (ctx.access.narrowed) throw forbidden('this token is narrowed with x-board-can, so it can' + "'" + 't ' + what + ": that's its project's sync's job")
}
/** The gates every sync record route shares: sync somewhere, and (for records) no narrowing. */
function needSync(ctx: Ctx, what: string, records: boolean) {
  if (!ctx.access.anywhere('sync')) throw forbidden('this token can' + "'" + 't ' + what + ': it needs sync')
  if (records) unnarrowed(ctx, what)
}

/** A client ID an import gives, as the board stores it: the importer's own, so no one else can take it. */
const importId = (ctx: Ctx, id: string) => (ctx.caller.principal.own ? id : 'sync:' + ctx.caller.principal.id + ':' + sha256('board-sync\u001f' + id).slice(0, 32))

/** The board thread a platform thread belongs to: its root's ID, or null. */
function threadOfExternal(ctx: Ctx, external: string): number | null {
  return ctx.sql.one<{ thread: number }>('select thread from sync_threads where external = ? order by rowid limit 1', external)?.thread ?? null
}

/** The board message a platform message is a copy of, or came in as. */
function messageOf(ctx: Ctx, thread: string, message: string): MessageRow | null {
  const copy =
    ctx.sql.one<{ message: number }>('select message from sync_copies where external_thread = ? and external_message = ? limit 1', thread, message) ??
    ctx.sql.one<{ message: number }>('select message from sync_copies where target = ? and external_message = ? limit 1', thread, message)
  return copy ? ctx.board.message(copy.message) : null
}

/** A root by its thread key: its client ID when it had one (indexed), else the key the board made. */
export function rootByKey(ctx: Ctx, key: string): MessageRow | null {
  hooks.keyed(ctx, key)
  const byClient = ctx.sql.one<MessageRow>('select * from messages where client_key = ? and re is null', key)
  if (byClient && byClient.thread_key === key) return byClient
  return ctx.sql.one<MessageRow>('select m.* from threads t join messages m on m.id = t.root where m.thread_key = ? limit 1', key)
}

// -- who an import is by ------------------------------------------------------------------------------

const SIGNED_IN = /^(user|worker|oidc|access|boards):|^github:repo:/

/** Checks that a caller may write as a platform user: answers the user's platform. */
function speaksFor(ctx: Ctx, user: PlatformUser, from: string | null, entries: SyncEntry[]): string {
  const id = user.id
  const base = id.split('+')[0]!
  const known = ctx.board.actor(id)
  const registrant = ctx.sql.one<{ owner: string }>('select owner from registrations where owner = ? or owner = ?', id, base)
  if (SIGNED_IN.test(id) || registrant || (known && known.kind !== 'external'))
    throw forbidden(id + ' is someone this board signs in, not a platform user: sync can' + "'" + 't write as them')
  const keys = entries.map((entry) => entry.key)
  if (from !== null && !keys.includes(from)) throw forbidden('this token doesn' + "'" + 't sync ' + from + ' here: its board registers its sync entries')
  const allowed = from !== null ? [from] : keys
  const key = allowed.find((name) => id.startsWith(name + ':'))
  if (key === undefined) throw forbidden(id + " isn't a user of " + (allowed.length ? allowed.join(' or ') : 'a sync key this token has') + ': their ID starts with its key')
  return entries.find((entry) => entry.key === key)!.platform
}

const typable = (value: string) =>
  value.normalize('NFKD').replace(/\p{M}/gu, '').toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/^[-._]+|[-._]+$/g, '')

export function importedHandle(via: string, handle: string, userId: string): string {
  let name = typable(handle) || typable(userId)
  const room = 128 - via.length - 1
  if (Array.from(name).length > room) name = Array.from(name).slice(0, Math.max(0, room)).join('').replace(/^[-._]+|[-._]+$/g, '')
  return via + '/' + name
}

const httpsAvatar = (avatar: string | null) => {
  if (!avatar) return null
  try {
    return new URL(avatar).protocol === 'https:' ? avatar : null
  } catch {
    return null
  }
}

/** The actor a platform user writes as here: a profile of the importer that speaks for them. */
function identityOf(ctx: Ctx, user: PlatformUser, platform: string): ActorRecord {
  const importer = ctx.caller.principal
  const avatar = httpsAvatar(user.avatar)
  if (importer.own) return { id: user.id, kind: 'external', handle: user.handle, name: user.name, avatar, platform }
  const userId = user.id.slice(user.id.indexOf(':') + 1)
  return {
    id: importer.id + '+' + user.id,
    kind: 'external',
    handle: importedHandle(importer.handle, user.handle, userId),
    name: user.name,
    avatar,
    via: { name: importer.handle, environment: null },
    platform,
    ...(importer.id.startsWith('boards:') ? {} : { verified: true }),
  }
}

const EXACT = /(?<![\w@.-])@\[([^\]\s]+)\]/g

/** The exact mentions of a text, outside code and blocks. */
const exactMentions = (text: string) => new Set([...prose(text).matchAll(EXACT)].map((match) => match[1]!))

/** Re-names each platform user a text mentions as the importer's profile of them. */
function renameMentions(ctx: Ctx, text: string, entries: SyncEntry[]): string {
  if (ctx.caller.principal.own || !text.includes('@[')) return text
  const body = prose(text)
  const keys = entries.map((entry) => entry.key)
  let out = ''
  let at = 0
  for (const match of body.matchAll(EXACT)) {
    const id = match[1]!
    if (!keys.some((key) => id.startsWith(key + ':'))) continue
    out += text.slice(at, match.index!) + '@[' + ctx.caller.principal.id + '+' + id + ']'
    at = match.index! + match[0].length
  }
  out += text.slice(at)
  return out.length > MESSAGE_TEXT_MAX ? text : out
}

/** Meets each mentioned platform user the board hasn't: one it knows keeps its record. */
function introduce(ctx: Ctx, users: PlatformUser[], from: string | null, entries: SyncEntry[]) {
  for (const user of users) {
    const record = identityOf(ctx, user, speaksFor(ctx, user, from, entries))
    if (!ctx.board.actor(record.id)) ctx.board.seen(record, ctx.now)
  }
}

/** Links as the board keeps them: its own snapshot for a board message the importer can read. */
function linksOf(ctx: Ctx, links: ImportLink[] | undefined) {
  return (links ?? []).map((link) => {
    const id = link.message !== null && /^[1-9]\d{0,15}$/.test(link.message) ? Number(link.message) : null
    const target = id !== null ? ctx.board.message(id) : null
    if (target && !target.deleted && ctx.access.readable(target.channel)) {
      const author = ctx.board.actor(target.actor)
      const files = json<{ name: string }[]>(target.attachments, []).map((file) => ({ name: file.name, url: null }))
      return { url: link.url, message: target.id, snapshot: { author: author?.name ?? target.actor, text: target.text, createdAt: iso(target.created_at), files }, unavailable: null }
    }
    return { url: link.url, message: null, snapshot: link.snapshot ?? null, unavailable: link.unavailable ?? null }
  })
}

/** Everything, for the write an import makes once its own checks have passed. */
const fully = (ctx: Ctx): Ctx => ({ ...ctx, access: accessOf({ full: true, grants: [], narrow: null }) })

function addCopy(ctx: Ctx, message: number, target: string, thread: string, external: string, by: string | null) {
  tables(ctx)
  ctx.sql.run('insert into sync_copies (message, target, external_thread, external_message) values (?, ?, ?, ?) on conflict (message, target) do update set external_thread = excluded.external_thread, external_message = excluded.external_message', message, target, thread, external)
  ctx.sql.run('insert into sync_copy_marks (message, target, by, files) values (?, ?, ?, null) on conflict (message, target) do update set by = excluded.by, files = null', message, target, by)
}

// -- imports ---------------------------------------------------------------------------------------

type ImportBody = {
  op: 'post' | 'edit' | 'delete' | 'react' | 'labels' | 'links'
  author: PlatformUser
  from: string | null
  mentioned?: PlatformUser[]
  source?: Source
  // post
  origin?: Origin | ImportOrigin | null
  channel?: string
  re?: string
  text?: string
  labels?: Record<string, string>
  noSync?: boolean
  attachments?: string[]
  links?: ImportLink[]
  id?: string
  after?: string
  // changes
  message?: string
  revision?: number
  emoji?: string
  remove?: boolean
  set?: Record<string, string>
  unset?: string[]
  if?: Record<string, string | null>
}

op('syncImport', (ctx, body: ImportBody) => {
  needSync(ctx, 'import', true)
  const entries = entriesOf(ctx)
  const platform = speaksFor(ctx, body.author, body.from, entries)
  const named = body.text !== undefined ? exactMentions(body.text) : new Set<string>()
  const mentioned = (body.mentioned ?? []).filter((user) => named.has(user.id))
  for (const user of mentioned) speaksFor(ctx, user, body.from, entries)
  if (body.labels) refuseReserved(Object.keys(body.labels))
  if (body.op === 'labels') refuseReserved([...Object.keys(body.set ?? {}), ...(body.unset ?? [])])
  if (body.op === 'post') return importPost(ctx, body, platform, entries, mentioned)
  return importChange(ctx, body, platform, entries, mentioned)
})

function importPost(ctx: Ctx, body: ImportBody, platform: string, entries: SyncEntry[], mentioned: PlatformUser[]) {
  if ((body.channel === undefined) === (body.re === undefined)) throw badRequest('an import needs \u0060channel\u0060; a reply needs \u0060re\u0060')
  let root: MessageRow | null = null
  let channel: string
  if (body.re !== undefined) {
    const target = ctx.board.readable(body.re, ctx.access)
    root = target.re === null ? target : ctx.board.message(target.re)
    if (!root) throw notFound('message not found: #' + body.re, 'message_not_found')
    channel = root.channel
  } else channel = body.channel!
  if (!ctx.access.can('sync', channel)) throw forbidden('this token can' + "'" + 't sync in ' + channel + ', so it can' + "'" + 't import there')
  const key = body.id !== undefined ? importId(ctx, body.id) : undefined
  const author = identityOf(ctx, body.author, platform)
  const write = fully(ctx)
  const posting = { ...(root ? { re: body.re! } : { channel }), text: body.text ?? '', labels: body.labels ?? {}, noSync: body.noSync, attachments: body.attachments, after: body.after }
  // A retry of an import that landed: the post stands, and its origin isn't checked again.
  if (key !== undefined && ctx.sql.one('select id from messages where client_key = ?', key)) {
    const { row } = postMessage(write, posting, { author, from: body.from, settle: false, checkBlocks: false, clientKey: key })
    return { message: ref(row.id) }
  }
  const origin = (body.origin ?? null) as Origin | null
  if (origin) {
    if (body.from === null) throw badRequest('an import with an origin names the sync key it came through: pass \u0060from\u0060')
    for (const at of [origin.channel, origin.thread, origin.subthread]) if (at != null && !at.startsWith(body.from + ':')) throw badRequest("an import's platform locations belong to its sync key: " + at + " isn't " + body.from + "'s")
    if (origin.subthread != null && !origin.subthread.startsWith(origin.thread + ':')) throw badRequest("an import's subthread is in its thread: " + origin.subthread + " isn't in " + origin.thread)
    const owner = threadOfExternal(ctx, origin.thread)
    if (owner !== null && (!root || owner !== root.id)) throw conflict('already_synced', origin.thread + ' is already synced with another thread')
    if (root && owner === null) throw conflict('not_synced', origin.thread + " isn't synced with this thread")
    const where = origin.subthread ?? origin.thread
    if (messageOf(ctx, where, origin.message)) throw conflict('already_synced', origin.message + ' in ' + where + ' is already on the board')
  }
  if (body.source && !entries.some((entry) => entry.key === body.source!.key)) throw forbidden('this token doesn' + "'" + 't sync ' + body.source.key + ' here: its board registers its sync entries')
  const text = renameMentions(ctx, body.text ?? '', entries)
  introduce(ctx, mentioned, body.from, entries)
  const importedBy = origin && !ctx.caller.principal.own ? ctx.caller.principal.id : undefined
  const links = linksOf(ctx, body.links)
  const { row } = postMessage(write, { ...posting, text }, {
    author,
    from: body.from,
    ...(origin ? { origin: { ...(origin.channel !== undefined ? { channel: origin.channel } : {}), thread: origin.thread, subthread: origin.subthread ?? null, message: origin.message, context: origin.context ?? null } } : {}),
    ...(importedBy ? { importedBy } : {}),
    ...(links.length ? { links } : {}),
    settle: false,
    checkBlocks: body.from === null,
    ...(key !== undefined ? { clientKey: key } : {}),
  })
  if (origin) {
    if (!root) ctx.sql.run("insert into sync_threads (thread, target, cause, kind, external) values (?, ?, 'import', 'thread', ?) on conflict do nothing", row.id, origin.thread, origin.thread)
    addCopy(ctx, row.id, origin.thread, origin.subthread ?? origin.thread, origin.message, importedBy ?? null)
  }
  return { message: ref(row.id) }
}

function importChange(ctx: Ctx, body: ImportBody, platform: string, entries: SyncEntry[], mentioned: PlatformUser[]) {
  if ((body.origin == null) === (body.message === undefined)) throw badRequest('a change names its message by \u0060origin\u0060 or by \u0060message\u0060, one or the other')
  let row: MessageRow | null = null
  if (body.origin) {
    const origin = body.origin as ImportOrigin
    if (origin.message !== undefined) row = messageOf(ctx, origin.thread, origin.message)
    else {
      const root = threadOfExternal(ctx, origin.thread)
      row = root === null ? null : ctx.board.message(root)
    }
  } else row = /^[1-9]\d{0,15}$/.test(body.message!) ? ctx.board.message(Number(body.message)) : null
  // As good as missing: nothing here for this sync to change.
  if (!row || !ctx.access.can('sync', row.channel)) return { message: null }
  const record = identityOf(ctx, body.author, platform)
  const by = byOf(record)
  const asAuthor = body.message !== undefined
  const own = row.actor === record.id
  const write = fully(ctx)
  const revisionCheck = () => {
    if (body.revision !== undefined && body.revision !== row!.revision) throw conflict('revision_conflict', '#' + row!.id + ' was ' + (row!.deleted ? 'deleted' : 'edited') + ' since revision ' + body.revision)
  }
  switch (body.op) {
    case 'edit': {
      if (asAuthor && !own) throw forbidden('only the author can edit a message')
      revisionCheck()
      if (row.deleted) throw badRequest('message was deleted', 'message_deleted')
      if (body.source && !entries.some((entry) => entry.key === body.source!.key)) throw forbidden('this token doesn' + "'" + 't sync ' + body.source.key + ' here: its board registers its sync entries')
      const text = renameMentions(ctx, body.text!, entries)
      introduce(ctx, mentioned, body.from, entries)
      ctx.board.seen(record, ctx.now)
      editMessage(write, row, text, by, body.from)
      break
    }
    case 'delete': {
      if (asAuthor && !own) throw forbidden('only the author can delete a message')
      revisionCheck()
      if (row.deleted) break
      ctx.board.seen(record, ctx.now)
      deleteMessage(write, row, by, body.from)
      break
    }
    case 'react': {
      if (row.deleted) throw badRequest('message was deleted', 'message_deleted')
      ctx.board.seen(record, ctx.now)
      reactTo(write, row, body.emoji!, Boolean(body.remove), by, body.from)
      break
    }
    case 'labels': {
      if (row.deleted) throw badRequest('message was deleted', 'message_deleted')
      ctx.board.seen(record, ctx.now)
      labelMessage(write, row, { set: body.set, unset: body.unset, if: body.if }, by)
      break
    }
    case 'links': {
      if (row.deleted) break
      const links = linksOf(ctx, body.links)
      ctx.board.seen(record, ctx.now)
      const before = ctx.board.facet(row.id)
      const seq = ctx.board.reserve()
      ctx.sql.run('update messages set links = ?, version = ? where id = ?', links.length ? JSON.stringify(links) : null, seq, row.id)
      ctx.board.append('message.linked', { id: row.id, thread: row.thread_key, links, by, from: body.from }, { at: ctx.now, message: row.id, thread: row.thread, before, seq })
      break
    }
  }
  return { message: ref(row.id) }
}

// -- receipts ---------------------------------------------------------------------------------------

/** Attaches a thread to a target: a thread.synced, once. */
function attach(ctx: Ctx, root: MessageRow, target: string, kind: 'channel' | 'thread', cause: string): boolean {
  if (ctx.sql.one('select 1 as there from sync_threads where thread = ? and target = ?', root.id, target)) return false
  if (kind === 'thread') {
    const other = threadOfExternal(ctx, target)
    if (other !== null && other !== root.id) {
      const theirs = ctx.board.message(other)
      throw conflict('already_synced', target + ' is already synced with ' + (theirs && ctx.access.readable(theirs.channel) ? '#' + other : 'another thread'))
    }
  }
  ctx.sql.run('insert into sync_threads (thread, target, cause, kind, external) values (?, ?, ?, ?, ?)', root.id, target, cause, kind, kind === 'thread' ? target : null)
  ctx.board.seen(ctx.actor, ctx.now)
  ctx.board.append('thread.synced', { thread: root.thread_key, target, cause, kind, by: ctx.author }, { at: ctx.now, thread: root.id })
  return true
}

/** A receipt that lands once per key, for whoever records it. */
function once(ctx: Ctx, key: string): boolean {
  const full = 'sync-receipt:' + ctx.caller.principal.id + ':' + key
  if (ctx.sql.one('select 1 as there from idempotency where key = ?', full)) return false
  ctx.sql.run("insert into idempotency (key, result, at) values (?, '{}', ?)", full, ctx.now)
  return true
}

type ReceiptBody =
  | { kind: 'message'; message: string; target: string; external: { thread: string; message: string }; files?: string[] | null }
  | { kind: 'files'; message: string; target: string; files: string[] | null }
  | { kind: 'failed'; message: string; target: string; error: string }
  | { kind: 'thread'; message: string; target: string; targetKind: 'channel' | 'thread'; cause: 'config' | 'request' }

op('syncReceipt', (ctx, body: ReceiptBody) => {
  unnarrowed(ctx, 'record what it synced')
  const row = /^[1-9]\d{0,15}$/.test(body.message) ? ctx.board.message(Number(body.message)) : null
  if (!row || !ctx.access.readable(row.channel)) throw notFound('message not found: #' + body.message, 'message_not_found')
  if (!ctx.access.can('sync', row.channel)) throw forbidden('this token can' + "'" + 't sync in ' + row.channel)
  const root = row.re === null ? row : ctx.board.message(row.re)!
  if (body.kind === 'thread') return { ok: true, attached: attach(ctx, root, body.target, body.targetKind, body.cause) }
  const key = keyOf(body.target)
  if (!entriesOf(ctx).some((entry) => entry.key === key)) throw forbidden('this token doesn' + "'" + 't sync ' + key + ' here: its board registers its sync entries')
  if (!ctx.sql.one('select 1 as there from sync_threads where thread = ? and target = ?', root.id, body.target)) throw new BoardsError(400, 'not_a_target', '#' + row.id + "'s thread doesn't sync with " + body.target)
  const syncedBy: Record<string, string> = ctx.caller.principal.own ? {} : { syncedBy: ctx.caller.principal.id }
  const by = ctx.caller.principal.own ? null : ctx.caller.principal.id
  tables(ctx)
  if (body.kind === 'message') {
    const external = body.external
    if (!external.thread.startsWith(key + ':')) throw badRequest('a delivery to ' + body.target + ' lands under ' + key + ', not in ' + external.thread)
    const owner = threadOfExternal(ctx, external.thread)
    if (owner !== null && owner !== root.id) throw conflict('already_synced', external.thread + ' is already synced with another thread')
    const other = ctx.sql.one<{ message: number }>('select message from sync_copies where external_thread = ? and external_message = ? and message != ?', external.thread, external.message, row.id)
    if (other) throw conflict('already_synced', external.message + ' in ' + external.thread + " is another board message's")
    if (once(ctx, 'receipt:' + row.id + ':' + body.target)) {
      addCopy(ctx, row.id, body.target, external.thread, external.message, by)
      if (row.re === null) ctx.sql.run("update sync_threads set external = ? where thread = ? and target = ? and kind = 'channel'", external.thread, root.id, body.target)
      const undelivered = json<Record<string, string>>(row.undelivered, {})
      const before = ctx.board.facet(row.id)
      const seq = ctx.board.reserve()
      if (Object.hasOwn(undelivered, body.target)) {
        delete undelivered[body.target]
        ctx.sql.run('update messages set undelivered = ?, version = ? where id = ?', Object.keys(undelivered).length ? JSON.stringify(undelivered) : null, seq, row.id)
      }
      ctx.board.append('message.synced', { id: row.id, thread: row.thread_key, target: body.target, external, ...syncedBy }, { at: ctx.now, message: row.id, thread: row.thread, before, seq })
    }
    if (body.files !== undefined) filesSynced(ctx, row, body.target, body.files, by, syncedBy)
    return { ok: true }
  }
  if (body.kind === 'files') {
    filesSynced(ctx, row, body.target, body.files, by, syncedBy)
    return { ok: true }
  }
  if (once(ctx, 'failed:' + row.id + ':' + body.target)) {
    const undelivered = json<Record<string, string>>(row.undelivered, {})
    undelivered[body.target] = body.error
    const before = ctx.board.facet(row.id)
    const seq = ctx.board.reserve()
    ctx.sql.run('update messages set undelivered = ?, version = ? where id = ?', JSON.stringify(undelivered), seq, row.id)
    ctx.board.append('message.sync_failed', { id: row.id, thread: row.thread_key, target: body.target, error: body.error }, { at: ctx.now, message: row.id, thread: row.thread, before, seq })
  }
  return { ok: true }
})

function filesSynced(ctx: Ctx, row: MessageRow, target: string, files: string[] | null, by: string | null, syncedBy: Record<string, string>) {
  if (!once(ctx, 'files:' + row.id + ':' + target)) return
  ctx.sql.run('update sync_copy_marks set files = ? where message = ? and target = ? and by is ?', JSON.stringify(files), row.id, target, by)
  const before = ctx.board.facet(row.id)
  ctx.board.append('message.files_synced', { id: row.id, thread: row.thread_key, target, files, ...syncedBy }, { at: ctx.now, message: row.id, thread: row.thread, before })
}

/** A post's sync targets, attached in its own transaction. */
hooks.syncTargets = (ctx, root, _thread, targets) => {
  const row = ctx.board.message(root)!
  for (const entry of targets) {
    const at = entry.target.indexOf(':')
    if (at <= 0) throw badRequest('sync targets look like <key>:<channel or thread>, got: ' + entry.target)
    attach(ctx, row, entry.target, entry.kind ?? kindOf(entry.target), 'request')
  }
}

op('sync', (ctx, body: { id: string; target: string }) => {
  const row = ctx.board.readable(body.id, ctx.access)
  if (!ctx.access.can('sync', row.channel)) throw forbidden('this token can' + "'" + 't sync in ' + row.channel)
  const at = body.target.indexOf(':')
  if (at <= 0) throw badRequest('sync targets look like <key>:<channel or thread>, got: ' + body.target)
  const root = row.re === null ? row : ctx.board.message(row.re)!
  return { target: body.target, attached: attach(ctx, root, body.target, kindOf(body.target), 'request') }
})

// -- lookups --------------------------------------------------------------------------------------

op('syncThread', (ctx, { thread }: { thread: string }) => {
  needSync(ctx, 'look up a sync', false)
  const root = rootByKey(ctx, thread)
  if (!root || !ctx.access.can('sync', root.channel)) throw notFound('no thread ' + thread + ' on this board', 'thread_not_found')
  const rows = ctx.sql.all<{ target: string; external: string | null }>('select target, external from sync_threads where thread = ? order by rowid', root.id)
  const external: Record<string, string> = {}
  for (const entry of rows) if (entry.external !== null) external[entry.target] = entry.external
  return { thread: root.thread_key, root: ref(root.id), channel: root.channel, targets: rows.map((entry) => entry.target), external }
}, { read: true })

op('syncFind', (ctx, query: { post?: string; thread?: string; message?: string }) => {
  needSync(ctx, 'look up a sync', false)
  const out: { thread: string | null; message: string | null } = { thread: null, message: null }
  if (query.post !== undefined) {
    const row = ctx.sql.one<MessageRow>('select * from messages where client_key = ?', importId(ctx, query.post))
    if (row && ctx.access.can('sync', row.channel)) out.message = ref(row.id)
  }
  if (query.thread !== undefined) {
    const owner = threadOfExternal(ctx, query.thread)
    const root = owner === null ? null : ctx.board.message(owner)
    if (root && ctx.access.can('sync', root.channel)) out.thread = root.thread_key
    if (query.message !== undefined) {
      const row = messageOf(ctx, query.thread, query.message)
      if (row && ctx.access.can('sync', row.channel)) out.message = ref(row.id)
    }
  }
  return out
}, { read: true })

op('syncCopies', (ctx, query: { message: string | string[] }) => {
  needSync(ctx, 'look up a sync', false)
  tables(ctx)
  const ids = (Array.isArray(query.message) ? query.message : [query.message]).filter((id) => /^[1-9]\d{0,15}$/.test(id))
  const mine = ctx.caller.principal.own ? null : ctx.caller.principal.id
  const copies: Record<string, Record<string, { thread: string; message: string; files?: string[] | null }>> = {}
  for (const id of ids) {
    const row = ctx.board.message(Number(id))
    if (!row || !ctx.access.can('sync', row.channel)) continue
    const found: Record<string, { thread: string; message: string; files?: string[] | null }> = {}
    const rows = ctx.sql.all<{ target: string; external_thread: string; external_message: string; by: string | null; files: string | null }>(
      'select c.target, c.external_thread, c.external_message, k.by, k.files from sync_copies c left join sync_copy_marks k on k.message = c.message and k.target = c.target where c.message = ?',
      row.id,
    )
    for (const copy of rows) {
      if ((copy.by ?? null) !== mine) continue
      found[copy.target] = { thread: copy.external_thread, message: copy.external_message, ...(copy.files !== null ? { files: JSON.parse(copy.files) } : {}) }
    }
    copies[ref(row.id)] = found
  }
  return { copies }
}, { read: true })

op('synced', (ctx, { id }: { id: string }) => {
  const row = ctx.board.readable(id, ctx.access)
  const root = row.re ?? row.id
  const undelivered = json<Record<string, string>>(row.undelivered, {})
  const targets = ctx.sql.all<{ target: string; external: string | null }>("select target, external from sync_threads where thread = ? order by rowid", root).map((entry) => {
    const copy =
      ctx.sql.one<{ external_thread: string; external_message: string }>('select external_thread, external_message from sync_copies where message = ? and target = ?', row.id, entry.target) ??
      (entry.external !== null ? ctx.sql.one<{ external_thread: string; external_message: string }>('select external_thread, external_message from sync_copies where message = ? and external_thread = ? limit 1', row.id, entry.external) : null)
    return { target: entry.target, key: keyOf(entry.target), thread: copy?.external_thread ?? entry.external ?? null, message: copy?.external_message ?? null, url: null, undelivered: undelivered[entry.target] ?? null }
  })
  return { targets }
}, { read: true })

/** The board thread a platform link names, from sync's records alone: every sync key of the link's platform is tried, the board's own and those registered with it. */
op('linked', (ctx, query: { url: string }) => {
  const none = () => notFound('no message on this board for that link', 'message_not_found')
  const keys = new Map<string, string>(ownSyncKeys(ctx))
  for (const row of ctx.sql.all<{ sync: string | null }>('select sync from registrations'))
    for (const entry of (json(row.sync, []) as { key: string; platform: string }[])) if (!keys.has(entry.key)) keys.set(entry.key, entry.platform)
  for (const target of linkTargets(query.url)) {
    for (const [key, platform] of keys) {
      if (platform !== target.platform) continue
      let found: MessageRow | null = null
      if ('issue' in target) {
        // A Linear issue's root carries its identifier as a label; a comment is a message in its thread.
        const hit = ctx.sql.one<{ message: number }>('select message from terms where term = ? order by message limit 1', 'l:issue=' + target.issue)
        const root = hit ? ctx.board.message(hit.message) : null
        const raw = root?.origin as unknown
        const origin = (typeof raw === 'string' ? json(raw, null) : raw) as { thread?: string } | null
        if (root && origin?.thread?.startsWith(key + ':')) found = target.comment ? messageOf(ctx, origin.thread, target.comment) : root
      } else {
        const thread = target.thread(key)
        // A link to a message finds that message's copy; a link to a thread finds its root.
        if (target.message) found = messageOf(ctx, thread, target.message)
        else {
          const owner = threadOfExternal(ctx, thread)
          found = owner === null ? null : ctx.board.message(owner)
        }
      }
      if (found && !found.deleted && ctx.access.readable(found.channel)) return OPS.message!(ctx, { id: String(found.id) })
    }
  }
  throw none()
}, { read: true })

/** Typing shows through the board's own sync: the targets of the thread its couriers take it to. It writes nothing. */
op('typing', (ctx, { id }: { id: string; status?: string }) => {
  const row = ctx.board.readable(id, ctx.access)
  if (row.deleted) throw notFound('message not found: #' + id, 'message_not_found')
  if (!ctx.access.can('post', row.channel)) throw forbidden('this token can' + "'" + 't post in ' + row.channel)
  const own = ownSyncKeys(ctx)
  const rows = own.size ? ctx.sql.all<{ target: string }>('select target from sync_threads where thread = ? order by rowid', row.re ?? row.id) : []
  const root = row.re === null ? row : ctx.board.message(row.re)
  return { targets: rows.map((entry) => entry.target).filter((target) => own.has(keyOf(target))), thread: root?.thread_key ?? null }
}, { read: true })

// -- the courier's subscription: @sync:<key> -----------------------------------------------------------

/** What a board's own sync copies out: these, in threads synced with a target of its key. */
const COURIER_TYPES = new Set(['message.posted', 'message.edited', 'message.deleted', 'reaction.added', 'reaction.removed', 'labels.changed', 'thread.synced'])

type CourierRow = { seq: number; type: string; thread: number | null; message: number | null; at: number; payload: string }

/** An event as the courier of a key gets it, or null: not in a thread synced there, or it came from there (its echo), or held back. */
export function courierMatch(ctx: Ctx, row: CourierRow, key: string): { thread: string; event: Record<string, unknown> } | null {
  if (!COURIER_TYPES.has(row.type) || row.thread === null) return null
  const payload = JSON.parse(row.payload) as Record<string, unknown>
  if (payload.from === key) return null
  const prefix = key + ':'
  if (row.type === 'thread.synced') {
    if (!String(payload.target ?? '').startsWith(prefix)) return null
  } else if (!ctx.sql.one('select 1 as there from sync_threads where thread = ? and substr(target, 1, ?) = ? limit 1', row.thread, prefix.length, prefix)) return null
  const message = ctx.board.message(row.message ?? row.thread)
  if (row.type === 'message.posted' && message?.no_sync) return null
  const event: Record<string, unknown> = { cursor: ref(row.seq), type: row.type, createdAt: iso(row.at), payload: payloadView(ctx, payload) }
  if (message) event.message = ctx.board.view(message, viewOptions(ctx))
  return { thread: String(row.thread), event }
}

// -- the inbox ------------------------------------------------------------------------------------

type InboxRow = { id: string; key: string; thread: string; channel: string | null; event: string; raw: string | null; at: number; state: string; lease: string | null; until: number | null; attempts: number; next_at: number }
type ExternalEvent = { kind: string; channel: string; thread: string; subthread?: string | null; [field: string]: unknown }

const SEP = '\u001f'
const laneOf = (owner: string, key: string) => owner + SEP + key
const KEEP_DONE_MS = 24 * 60 * 60 * 1000

op('inboxReplay', (ctx) => {
  if (!ctx.access.everywhere('manage')) throw forbidden("this token can't replay an inbox: that takes manage everywhere")
  return { replayed: 0 }
}, { read: true })

op('inboxPush', (ctx, body: { key: string; events: { id: string; event: ExternalEvent; raw: unknown }[] }) => {
  needSync(ctx, 'push to an inbox', true)
  for (const item of body.events) {
    if (item.id.length > 300) throw badRequest('an inbox event ID is 300 characters at most, got ' + item.id.length)
    for (const at of [item.event.channel, item.event.thread, item.event.subthread]) if (at != null && !at.startsWith(body.key + ':')) throw badRequest("an inbox's platform locations belong to its sync key: " + at + " isn't " + body.key + "'s")
  }
  const owner = ctx.caller.principal.id
  const lane = laneOf(owner, body.key)
  // What's done is kept a day, so a platform's late retry still lands once.
  ctx.sql.run("delete from inbox where key = ? and state != 'pending' and at < ?", lane, ctx.now - KEEP_DONE_MS)
  for (const item of body.events)
    ctx.sql.run(
      "insert into inbox (id, key, thread, channel, event, raw, at, state, attempts, next_at) values (?, ?, ?, ?, ?, ?, ?, 'pending', 0, 0) on conflict (id) do nothing",
      derivedId('board-inbox' + SEP + owner + SEP + body.key + SEP + item.id), lane, item.event.thread, item.event.channel, JSON.stringify(item.event), JSON.stringify(item.raw ?? null), ctx.now,
    )
  return { ok: true }
})

op('inboxNext', (ctx, query: { key: string; limit?: number }) => {
  if (ctx.caller.principal.own) return { items: [] }
  needSync(ctx, 'pull from an inbox', true)
  const limit = query.limit ?? 10
  const lane = laneOf(ctx.caller.principal.id, query.key)
  const now = ctx.now
  const threads = ctx.sql.all<{ thread: string }>("select thread, min(at) as first, min(rowid) as n from inbox where key = ? and state = 'pending' group by thread order by first, n", lane)
  const items: Record<string, unknown>[] = []
  for (const { thread } of threads) {
    if (items.length >= limit) break
    for (;;) {
      const head = ctx.sql.one<InboxRow>("select * from inbox where key = ? and thread = ? and state = 'pending' order by at, rowid limit 1", lane, thread)
      if (!head) break
      const leased = head.lease !== null && head.until !== null
      if (leased && head.until! > now) break
      if (head.next_at > now) break
      if (leased && head.attempts >= TRIES) {
        ctx.sql.run("update inbox set state = 'failed', lease = null, until = null where id = ?", head.id)
        continue
      }
      const lease = leaseId()
      ctx.sql.run('update inbox set lease = ?, until = ?, attempts = attempts + 1 where id = ?', lease, now + LEASE_MS, head.id)
      items.push({ id: head.id, key: query.key, thread: head.thread, lease, attempt: head.attempts, event: JSON.parse(head.event), raw: json(head.raw, null) })
      break
    }
  }
  return { items }
})

op('inboxAck', (ctx, body: { key: string; id: string; lease: string; error?: string }) => {
  needSync(ctx, 'ack an inbox event', true)
  const prefix = ctx.caller.principal.id + SEP
  const row = ctx.sql.one<InboxRow>("select * from inbox where id = ? and substr(key, 1, ?) = ? and state = 'pending'", body.id, prefix.length, prefix)
  if (!row) throw notFound('no inbox event ' + body.id + ' is waiting for this token', 'no_item')
  if (row.lease !== body.lease) throw new BoardsError(409, 'stale_lease', 'that lease ran out, and the event was pulled again')
  if (body.error === undefined) ctx.sql.run("update inbox set state = 'done', lease = null, until = null where id = ?", row.id)
  else if (row.attempts >= TRIES) ctx.sql.run("update inbox set state = 'failed', lease = null, until = null where id = ?", row.id)
  else ctx.sql.run('update inbox set lease = null, until = null, next_at = ? where id = ?', ctx.now + backoff(row.attempts), row.id)
  return { ok: true }
})

op('inbox', (ctx, query: { key: string; channel?: string; limit?: number }) => {
  needSync(ctx, 'read an inbox', true)
  const limit = query.limit ?? 50
  const everyone = ctx.access.everywhere('sync')
  const rows = everyone
    ? ctx.sql.all<InboxRow>('select rowid as n, * from inbox where substr(key, length(key) - ? + 1) = ? and (? is null or channel = ?) order by at desc, n desc limit ?', SEP.length + query.key.length, SEP + query.key, query.channel ?? null, query.channel ?? null, limit)
    : ctx.sql.all<InboxRow>('select rowid as n, * from inbox where key = ? and (? is null or channel = ?) order by at desc, n desc limit ?', laneOf(ctx.caller.principal.id, query.key), query.channel ?? null, query.channel ?? null, limit)
  return { events: rows.map((row) => ({ id: row.id, channel: row.channel, createdAt: iso(row.at), sync: query.key, event: JSON.parse(row.event), raw: json(row.raw, null) })) }
}, { read: true })


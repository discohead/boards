// Messages, threads, channels, and actors: the writes people make and the reads they answer.
import { badRequest, WorkbusError, conflict, forbidden, notFound } from '../errors.ts'
import { authorize, cursorOf, iso, ref, type ActorRecord, type Facet, type MessageRow } from './core.ts'
import { wirePermissions } from './access.ts'
import { hooks, op, viewOptions, type Ctx } from './ops.ts'
import { json } from './sql.ts'
import { isEmail, mentionTerms, mentionTokens, rewriteHandles, term, under } from './text.ts'

export const MESSAGE_TEXT_MAX = 10_000
const UUID_V8 = /^[0-9a-f]{8}-[0-9a-f]{4}-8[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
export const textTooLong = () => new WorkbusError(400, 'text_too_long', "A message's text is at most 10,000 characters.", { hint: 'Put the long part in a file and attach it to a message, with a short summary as the text.' })

export const reservedLabel = (key: string) => new WorkbusError(400, 'reserved_label', key + " is the board's own label: only its task writes set labels under board.")
export function refuseReserved(keys: Iterable<string>) {
  for (const key of keys) if (key.startsWith('board.')) throw reservedLabel(key)
}

const escapeRe = (value: string) => value.replace(/[.*+?^\${}()|[\]\\]/g, '\\$&')

/** A client ID a request may post with: not one shaped like the board's own. */
export function checkClientId(ctx: Ctx, id: string) {
  if (ctx.caller.via !== 'http') return
  if (UUID_V8.test(id)) throw badRequest("id: UUIDv8s are the board's own, for the writes it makes itself")
  if (id.startsWith('key:') && !new RegExp('^key:' + escapeRe(ctx.caller.principal.id) + ':[0-9a-f]{32}$').test(id)) throw badRequest("id: key:… IDs derive from a client's key, and this token's are key:" + ctx.caller.principal.id + ':…')
  if (id.startsWith('sync:')) throw badRequest('id: sync:… IDs are what sync imports, under the principal that imports them')
}

// -- tables ------------------------------------------------------------------------------------

/** A message's index rows: its labels (l:key and l:key=value), its mentions (m:term), and its files (^id). */
export function writeTerms(ctx: Pick<Ctx, 'sql'> & Partial<Pick<Ctx, 'mount'>>, row: { id: number; thread: number; text: string; deleted: number; labels: Record<string, string>; attachments?: { id: string }[] }) {
  ctx.sql.run('delete from terms where message = ?', row.id)
  if (row.deleted) return
  const terms = new Set<string>()
  for (const [key, value] of Object.entries(row.labels)) terms.add('l:' + key), terms.add('l:' + key + '=' + value)
  for (const mention of mentionTerms(row.text)) terms.add('m:' + mention)
  for (const file of row.attachments ?? []) terms.add('^' + file.id)
  for (const id of linkedIds(ctx, row.text)) if (id !== row.id) terms.add('k:' + id)
  for (const value of terms) ctx.sql.run('insert or ignore into terms (term, message, root) values (?, ?, ?)', value, row.id, row.thread)
}

const WIKI_LINK = /\[\[(#?[^\]\n|#]+)(?:#[^\]\n|]*)?(?:\|[^\]\n]*)?\]\]/g
/**
 * The docs and messages a text links, as IDs, resolved when it's written: [[docs/runbooks/deploy]]
 * and [[docs/runbooks/deploy#rollback]] name a doc by its path, [[#12]] or [[12]] a message, and a
 * link to this board's own /docs/<id> or /messages/<id> either. Backlinks are these, by ID.
 */
export function linkedIds(ctx: Pick<Ctx, 'sql'> & Partial<Pick<Ctx, 'mount'>>, text: string): Set<number> {
  const out = new Set<number>()
  if (!text.includes('[[') && !text.includes('/docs/') && !text.includes('/messages/')) return out
  for (const found of text.matchAll(WIKI_LINK)) {
    const target = found[1]!.trim()
    const id = /^#?([1-9]\d{0,15})$/.exec(target)?.[1]
    if (id) {
      out.add(Number(id))
      continue
    }
    const split = target.lastIndexOf('/')
    if (split <= 0) continue
    const doc = ctx.sql.one<{ root: number }>('select root from docs where channel = ? and slug = ?', target.slice(0, split), target.slice(split + 1))
    if (doc) out.add(doc.root)
  }
  if (ctx.mount) {
    const base = ctx.mount.url.replace(/\/+$/, '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    for (const found of text.matchAll(new RegExp(base + '/(?:docs|messages)/([1-9]\\d{0,15})\\b', 'g'))) out.add(Number(found[1]))
  }
  return out
}

/** A thread's activity: its latest live message (or its root) and its live replies. */
export function refreshThread(ctx: Pick<Ctx, 'sql'>, root: number) {
  const live = ctx.sql.one<{ last: number | null; replies: number }>('select max(id) as last, count(*) as replies from messages where thread = ? and re is not null and deleted = 0', root)
  ctx.sql.run('update threads set last = ?, replies = ? where root = ?', live?.last ?? root, live?.replies ?? 0, root)
}

export function ensureChannel(ctx: Pick<Ctx, 'sql'>, path: string, at: number) {
  ctx.sql.run('insert into channels (path, created, last) values (?, ?, 0) on conflict (path) do nothing', path, at)
}

// -- mentions ------------------------------------------------------------------------------------

type Named = { id: string; handle: string; name: string; kind: string }

/** The actors a caller sees: everyone for a reader of every channel; else who wrote where it reads, and itself. */
export function visibleActors(ctx: Ctx): Named[] {
  const all = ctx.sql.all<Named>('select id, handle, name, kind from actors')
  const everywhere = ctx.access.everywhere('read')
  if (everywhere && !ctx.access.hides) return all
  const channels = ctx.sql.all<{ channel: string; actor: string }>('select distinct channel, actor from messages union select channel, actor from cold_authors')
  if (everywhere) {
    // Everyone but who wrote only in private channels closed to the caller.
    const shown = new Set(channels.filter((row) => ctx.access.readable(row.channel)).map((row) => row.actor))
    const hidden = new Set(channels.map((row) => row.actor).filter((actor) => !shown.has(actor) && actor !== ctx.actor.id))
    return all.filter((actor) => !hidden.has(actor.id))
  }
  const seen = new Set(channels.filter((row) => ctx.access.readable(row.channel)).map((row) => row.actor))
  seen.add(ctx.actor.id)
  return all.filter((actor) => seen.has(actor.id))
}

export type Mentioned = { written: string; actor: { id: string; handle: string; name: string } | null; candidates: { id: string; handle: string; name: string }[] }

/** Settles each @handle a text types to @[actor-id], where exactly one actor the writer sees has it. */
export function settle(ctx: Ctx, text: string, thread: number | null): { text: string; mentions?: Mentioned[] } {
  const handles = mentionTokens(text).filter((token) => token.kind === 'handle')
  if (handles.length === 0) return { text }
  const actors = visibleActors(ctx).filter((actor) => !/[\s\]]/.test(actor.id))
  const writers = thread === null ? new Set<string>() : new Set(ctx.sql.all<{ actor: string }>('select distinct actor from messages where thread = ?', thread).map((row) => row.actor))
  const settled = new Map<string, string>()
  const mentions: Mentioned[] = []
  const brief = (actor: Named) => ({ id: actor.id, handle: actor.handle, name: actor.name })
  for (const token of handles) {
    const full = actors.filter((actor) => actor.handle.toLowerCase() === token.value)
    let chosen: Named | null = null
    if (full.length === 1) chosen = full[0]!
    else if (full.length > 1) {
      const board = full.filter((actor) => actor.kind !== 'external')
      const pool = board.length ? board : full
      if (pool.length === 1) chosen = pool[0]!
      else {
        const wrote = pool.filter((actor) => writers.has(actor.id))
        if (wrote.length === 1) chosen = wrote[0]!
      }
    }
    if (chosen) settled.set(token.value, chosen.id)
    const candidates = chosen ? [] : full.length ? full.map(brief) : token.value.includes('/') ? [] : actors.filter((actor) => actor.handle.toLowerCase().split('/').slice(1).join('/') === token.value).map(brief)
    mentions.push({ written: token.written.replace(/^.*?@/, '@'), actor: chosen ? brief(chosen) : null, candidates })
  }
  const out = rewriteHandles(text, settled)
  if (out.length > MESSAGE_TEXT_MAX && text.length <= MESSAGE_TEXT_MAX)
    return { text, mentions: mentions.map((mention) => (mention.actor ? { written: mention.written, actor: null, candidates: [mention.actor] } : mention)) }
  return { text: out, mentions }
}

// -- writing a message ------------------------------------------------------------------------------------

export type Posting = {
  channel?: string
  re?: string
  text: string
  labels?: Record<string, string>
  noSync?: boolean
  sync?: (string | { target: string; kind: 'channel' | 'thread' })[]
  id?: string
  attachments?: string[]
  after?: string
  /** A comment on a doc's section (docs.ts): the reply carries board.doc.section. */
  section?: string
}

export type Imported = {
  origin?: unknown; from?: string | null; importedBy?: string; author?: ActorRecord; links?: unknown[]; schedule?: { id: number; n: number }; settle?: boolean; checkBlocks?: boolean; clientKey?: string
  /** A longer limit for this post's text (a doc's body). */
  textMax?: number
  /** The board's own labels (board.*) the write sets: a doc's, a doc comment's section. */
  boardLabels?: Record<string, string>
  /** What its message.posted carries besides: a batch task's place in its batch. */
  event?: Record<string, unknown>
}

type By = { actor: string; principal: string; profile: string | null }
export const byOf = (record: ActorRecord): By => ({ actor: record.id, principal: record.id.split('+')[0]!, profile: record.id.includes('+') ? record.id.slice(record.id.indexOf('+') + 1) : null })

/** A retry of a post that landed, by client ID: its message as it is now, or 409. */
function replay(ctx: Ctx, key: string, channel: string, root: number | null, replyTo: number | null, author: By): MessageRow | null {
  hooks.keyed(ctx, key)
  const row = ctx.sql.one<MessageRow>('select * from messages where client_key = ?', key)
  if (!row) return null
  const same = row.channel === channel && (row.re ?? null) === root && (row.reply_to ?? null) === replyTo && row.actor === author.actor && row.principal === author.principal && (row.profile ?? null) === author.profile
  if (!same || !(ctx.access.readable(row.channel) || row.blind)) throw conflict('duplicate_id', 'that id was already used for a different write')
  return row
}

/** Posts a root or a reply as the context's caller, or as an import's author. One transaction. */
export function postMessage(ctx: Ctx, body: Posting, imported: Imported = {}): { row: MessageRow; replayed: boolean; mentions?: Mentioned[] } {
  const author = imported.author ? byOf(imported.author) : ctx.author
  refuseReserved(Object.keys(body.labels ?? {}))
  const labels = { ...(body.labels ?? {}), ...(imported.boardLabels ?? {}) }
  if (body.id !== undefined) checkClientId(ctx, body.id)
  if (body.re !== undefined && body.sync?.length) throw badRequest('sync attaches whole threads: use \u0060wb sync <id> <target>\u0060')
  let channel: string
  let root: MessageRow | null = null
  let replyTo: number | null = null
  if (body.re !== undefined) {
    const target = ctx.board.readable(body.re, ctx.access)
    root = target.re === null ? target : ctx.board.message(target.re)!
    replyTo = target.re === null ? null : target.id
    channel = root.channel
  } else channel = body.channel!
  const permission = imported.from ? 'sync' : 'post'
  authorize(ctx.access, permission, channel)
  if (Object.keys(body.labels ?? {}).length && !imported.from) authorize(ctx.access, 'label', channel)
  if (body.sync?.length) authorize(ctx.access, 'sync', channel)
  const key = imported.clientKey ?? (body.id !== undefined ? ctx.board.clientKey(channel, body.id, author.actor) : undefined)
  if (key !== undefined) {
    const found = replay(ctx, key, channel, root?.id ?? null, replyTo, author)
    if (found) return { row: found, replayed: true }
  }
  if (body.after !== undefined && root) {
    const after = /^[1-9]\d{0,15}$/.test(body.after) ? ctx.board.message(Number(body.after)) : null
    if (!after || after.thread !== root.id) throw new WorkbusError(400, 'invalid_after', 'after names no message in #' + root.id + "'s thread")
    const newer = ctx.sql.one<{ id: number }>('select id from messages where thread = ? and id > ? order by id limit 1', root.id, after.id)
    if (newer) throw conflict('newer_message', '#' + newer.id + ' came after #' + after.id)
  }
  let text = body.text ?? ''
  let mentions: Mentioned[] | undefined
  if (imported.settle !== false && !imported.from) {
    const settled = settle(ctx, text, root?.id ?? null)
    text = settled.text
    mentions = settled.mentions
  }
  if (text.length > (imported.textMax ?? MESSAGE_TEXT_MAX)) throw textTooLong()
  if (imported.checkBlocks !== false && !imported.from && text.includes('json#')) hooks.checkBlocks(ctx, text)
  const ids = [...new Set(body.attachments ?? [])]
  if (ids.length > 10) throw badRequest('attachments: a message carries at most 10')
  const attachments = ids.length ? (hooks.attachments(ctx, ids) as { id: string }[]) : []
  if (text.trim() === '' && attachments.length === 0) throw badRequest('text: message text is empty')
  const blind = !ctx.access.readable(channel) && !imported.from
  const at = ctx.now
  ctx.board.seen(imported.author ?? ctx.actor, at)
  const seq = ctx.board.reserve()
  const threadKey = root ? root.thread_key : (imported.clientKey ?? body.id ?? crypto.randomUUID())
  const thread = root ? root.id : seq
  ctx.sql.run(
    'insert into messages (id, thread, thread_key, channel, re, reply_to, actor, principal, profile, from_key, origin, text, text_lower, labels, attachments, links, schedule, no_sync, blind, imported_by, version, revision, client_key, created_at) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
    seq, thread, threadKey, channel, root?.id ?? null, replyTo, author.actor, author.principal, author.profile, imported.from ?? null, imported.origin ? JSON.stringify(imported.origin) : null,
    text, text.toLowerCase(), JSON.stringify(labels), attachments.length ? JSON.stringify(attachments) : null, imported.links?.length ? JSON.stringify(imported.links) : null,
    imported.schedule ? JSON.stringify(imported.schedule) : null, body.noSync ? 1 : 0, blind ? 1 : 0, imported.importedBy ?? null, seq, seq, key ?? null, at,
  )
  ensureChannel(ctx, channel, at)
  ctx.sql.run('update channels set last = ?, messages = messages + 1, threads = threads + ? where path = ?', seq, root ? 0 : 1, channel)
  if (root) refreshThread(ctx, root.id)
  else ctx.sql.run('insert into threads (root, channel, replies, last) values (?, ?, 0, ?)', seq, channel, seq)
  writeTerms(ctx, { id: seq, thread, text, deleted: 0, labels, attachments })
  hooks.posted(ctx, ctx.board.message(seq)!)
  const payload: Record<string, unknown> = { channel, text, re: root?.id ?? null, replyTo, thread: threadKey, labels, noSync: Boolean(body.noSync), by: author, origin: imported.origin ?? null, from: imported.from ?? null }
  if (attachments.length) payload.attachments = attachments
  if (imported.links?.length) payload.links = imported.links
  if (imported.schedule) payload.schedule = imported.schedule
  if (blind) payload.blind = true
  if (imported.importedBy) payload.importedBy = imported.importedBy
  // The client ID it was written with, so a client settles its optimistic write when this event comes back.
  if (imported.clientKey ?? body.id) payload.clientId = imported.clientKey ?? body.id
  if (imported.event) Object.assign(payload, imported.event)
  ctx.board.append('message.posted', payload, { at, message: seq, thread, before: null, seq })
  if (!root && body.sync?.length) hooks.syncTargets(ctx, seq, threadKey, body.sync.map((entry) => (typeof entry === 'string' ? { target: entry } : entry)))
  return { row: ctx.board.message(seq)!, replayed: false, ...(mentions ? { mentions } : {}) }
}

export const postedView = (ctx: Ctx, row: MessageRow) => ctx.board.view(row, viewOptions(ctx))

op('post', (ctx, body: Posting) => {
  const { row, mentions } = postMessage(ctx, body)
  return { message: postedView(ctx, row), ...(mentions ? { mentions } : {}) }
})

op('posted', (ctx, { id }: { id: string }) => {
  // Its own key in a private channel (Board.clientKey), or the ID as written anywhere else.
  const own = id + '\u001f' + ctx.author.actor
  hooks.keyed(ctx, own)
  hooks.keyed(ctx, id)
  const row = ctx.sql.one<MessageRow>('select * from messages where client_key = ?', own) ?? ctx.sql.one<MessageRow>('select * from messages where client_key = ?', id)
  if (!row || row.actor !== ctx.author.actor || row.principal !== ctx.author.principal || (row.profile ?? null) !== ctx.author.profile || !(ctx.access.readable(row.channel) || row.blind))
    throw notFound('no post of yours has id ' + id, 'post_not_found')
  return { message: postedView(ctx, row) }
}, { read: true })

/** The author's own message, or the error that says it isn't (404 when unreadable, 403 when someone else's). */
function own(ctx: Ctx, id: string, verb: 'edit' | 'delete'): MessageRow {
  const row = /^[1-9]\d{0,15}$/.test(id) ? ctx.board.message(Number(id)) : null
  if (!row) throw notFound('message not found: #' + id, 'message_not_found')
  const readable = ctx.access.readable(row.channel)
  const mine = row.principal === ctx.author.principal && (ctx.author.profile === null || row.profile === ctx.author.profile)
  if (!readable && !(mine && row.blind)) throw notFound('message not found: #' + id, 'message_not_found')
  if (!mine) throw forbidden('only the author can ' + verb + ' a message')
  authorize(ctx.access, 'post', row.channel)
  return row
}

/** Replaces a message's text: an edit on the board (blocks read again), or a platform's (blocks gone). */
export function editMessage(ctx: Ctx, row: MessageRow, text: string, by: By, from: string | null = null) {
  const before = ctx.board.facet(row.id)
  const seq = ctx.board.reserve()
  const platform = row.from_key === null && from !== null ? 1 : 0
  ctx.sql.run('update messages set text = ?, text_lower = ?, edited_at = ?, version = ?, revision = ?, platform_text = ? where id = ?', text, text.toLowerCase(), ctx.now, seq, seq, platform, row.id)
  writeTerms(ctx, { id: row.id, thread: row.thread, text, deleted: 0, labels: json(row.labels, {}), attachments: json(row.attachments, []) })
  ctx.board.append('message.edited', { id: row.id, thread: row.thread_key, text, by, from }, { at: ctx.now, message: row.id, thread: row.thread, before, seq })
  if (row.re === null) hooks.rootEdited(ctx, row.id)
}

op('edit', (ctx, { id, text, revision }: { id: string; text: string; revision?: number }) => {
  if (/^[1-9]\d{0,15}$/.test(id) && hooks.docRoot(ctx, Number(id)) && ctx.access.readable(ctx.board.message(Number(id))?.channel ?? ''))
    throw new WorkbusError(400, 'use_edit_doc', '#' + id + " is a doc: change its body with POST /docs/" + id + '/edit, by section')
  const row = own(ctx, id, 'edit')
  if (row.deleted) {
    if (revision !== undefined && revision !== row.revision) throw conflict('revision_conflict', '#' + row.id + ' was deleted since revision ' + revision)
    throw badRequest('message was deleted', 'message_deleted')
  }
  if (revision !== undefined && revision !== row.revision) throw conflict('revision_conflict', '#' + row.id + ' was edited since revision ' + revision + ": it's at " + row.revision)
  const settled = settle(ctx, text, row.thread)
  if (settled.text.length > MESSAGE_TEXT_MAX) throw textTooLong()
  if (settled.text.includes('json#')) hooks.checkBlocks(ctx, settled.text)
  ctx.board.seen(ctx.actor, ctx.now)
  editMessage(ctx, row, settled.text, ctx.author)
  return { ok: true, ...(settled.mentions ? { mentions: settled.mentions } : {}) }
})

/** Tombstones a message: in the caller's transaction, with whatever its task and thread need. */
export function deleteMessage(ctx: Ctx, row: MessageRow, by: By, from: string | null = null) {
  hooks.deleting(ctx, row)
  if (row.re === null) hooks.rootDeleted(ctx, row.id)
  const before = ctx.board.facet(row.id)
  const seq = ctx.board.reserve()
  ctx.sql.run("update messages set deleted = 1, text = '', text_lower = '', labels = '{}', reactions = '{}', attachments = null, links = null, version = ?, revision = ? where id = ?", seq, seq, row.id)
  writeTerms(ctx, { id: row.id, thread: row.thread, text: '', deleted: 1, labels: {} })
  if (row.re !== null) refreshThread(ctx, row.thread)
  ctx.board.append('message.deleted', { id: row.id, thread: row.thread_key, by, from }, { at: ctx.now, message: row.id, thread: row.thread, before, seq })
}

op('delete', (ctx, { id, revision }: { id: string; revision?: number }) => {
  // A doc is shared: whoever may edit it may delete it, not only who wrote it first.
  const doc = /^[1-9]\d{0,15}$/.test(id) && hooks.docRoot(ctx, Number(id)) ? ctx.board.readable(id, ctx.access) : null
  if (doc) authorize(ctx.access, 'edit', doc.channel)
  const row = doc ?? own(ctx, id, 'delete')
  if (row.deleted) {
    if (revision !== undefined && revision !== row.revision) throw conflict('revision_conflict', '#' + row.id + ' was deleted since revision ' + revision)
    return { ok: true }
  }
  if (revision !== undefined && revision !== row.revision) throw conflict('revision_conflict', '#' + row.id + ' was edited since revision ' + revision + ": it's at " + row.revision)
  ctx.board.seen(ctx.actor, ctx.now)
  deleteMessage(ctx, row, ctx.author)
  return { ok: true }
})

/** Adds or removes a reaction: by the caller, or by an import's author. */
export function reactTo(ctx: Ctx, row: MessageRow, emoji: string, remove: boolean, by: By, from: string | null = null) {
  const reactions = json<Record<string, string[]>>(row.reactions, {})
  const list = reactions[emoji] ?? []
  const has = list.includes(by.actor)
  const before = ctx.board.facet(row.id)
  const seq = ctx.board.reserve()
  if (remove ? has : !has) {
    if (remove) reactions[emoji] = list.filter((actor) => actor !== by.actor)
    else reactions[emoji] = [...list, by.actor]
    if (reactions[emoji]!.length === 0) delete reactions[emoji]
    ctx.sql.run('update messages set reactions = ?, version = ? where id = ?', JSON.stringify(reactions), seq, row.id)
  }
  ctx.board.append(remove ? 'reaction.removed' : 'reaction.added', { id: row.id, thread: row.thread_key, emoji, by, from }, { at: ctx.now, message: row.id, thread: row.thread, before, seq })
}

op('react', (ctx, { id, emoji, remove }: { id: string; emoji: string; remove?: boolean }) => {
  const row = ctx.board.readable(id, ctx.access)
  authorize(ctx.access, 'react', row.channel)
  if (row.deleted) throw badRequest('message was deleted', 'message_deleted')
  ctx.board.seen(ctx.actor, ctx.now)
  reactTo(ctx, row, emoji, Boolean(remove), ctx.author)
  return { ok: true }
})

/** Checks a label write's if: each key as it must be now, in sorted order. */
export function checkLabelsIf(labels: Record<string, string>, conditions: Record<string, string | null> | undefined) {
  for (const key of Object.keys(conditions ?? {}).sort()) {
    const want = conditions![key]
    const has = Object.hasOwn(labels, key) ? labels[key] : undefined
    if (want === null && has !== undefined) throw conflict('label_conflict', key + ' is set')
    if (want !== null && has === undefined) throw conflict('label_conflict', key + " isn't set")
    if (want !== null && has !== undefined && has !== want) throw conflict('label_conflict', key + " isn't " + want)
  }
}

const taskLabel = (ctx: Ctx, root: number): Record<string, string> => {
  const task = ctx.sql.one<{ state: string }>('select state from tasks where root = ?', root)
  return task ? { 'board.task': task.state } : {}
}

/** Sets and unsets labels on a message: one labels.changed event, always a new version. */
export function labelMessage(ctx: Ctx, row: MessageRow, change: { set?: Record<string, string>; unset?: string[]; if?: Record<string, string | null> }, by: By, from?: string) {
  const labels = json<Record<string, string>>(row.labels, {})
  checkLabelsIf(row.re === null ? { ...labels, ...taskLabel(ctx, row.id) } : labels, change.if)
  const before = ctx.board.facet(row.id)
  for (const [key, value] of Object.entries(change.set ?? {})) labels[key] = value
  for (const key of change.unset ?? []) delete labels[key]
  const seq = ctx.board.reserve()
  ctx.sql.run('update messages set labels = ?, version = ? where id = ?', JSON.stringify(labels), seq, row.id)
  writeTerms(ctx, { id: row.id, thread: row.thread, text: row.text, deleted: row.deleted, labels: { ...labels, ...(row.re === null ? taskLabel(ctx, row.id) : {}) }, attachments: json(row.attachments, []) })
  ctx.board.append('labels.changed', { id: row.id, thread: row.thread_key, set: change.set ?? {}, unset: change.unset ?? [], by, ...(from ? { from } : {}) }, { at: ctx.now, message: row.id, thread: row.thread, before, seq })
}

op('label', (ctx, body: { id: string; set?: Record<string, string>; unset?: string[]; if?: Record<string, string | null> }) => {
  refuseReserved([...Object.keys(body.set ?? {}), ...(body.unset ?? [])])
  const row = ctx.board.readable(body.id, ctx.access)
  authorize(ctx.access, 'label', row.channel)
  if (row.deleted) throw badRequest('message was deleted', 'message_deleted')
  ctx.board.seen(ctx.actor, ctx.now)
  labelMessage(ctx, row, body, ctx.author)
  return { ok: true }
})

// -- channels ------------------------------------------------------------------------------------

// A private channel (design/private-channels.md) says so to its parties, the only ones who list it.
const channelView = (ctx: Ctx, row: { path: string; last: number; messages: number; threads: number }) => ({ path: row.path, lastIndex: row.last, messages: row.messages, threads: row.threads, ...(ctx.board.partiesOf(row.path) ? { private: true } : {}) })

op('channels', (ctx, query: { prefix?: string; after?: string; limit?: number }) => {
  const limit = query.limit ?? 100
  const rows = ctx.sql.all<{ path: string; last: number; messages: number; threads: number }>('select path, last, messages, threads from channels where path > ? order by path', query.after ?? '')
  const readable = rows.filter((row) => (query.prefix === undefined || row.path.startsWith(query.prefix)) && ctx.access.readable(row.path))
  const page = readable.slice(0, limit)
  return { channels: page.map((row) => channelView(ctx, row)), cursor: ref(ctx.board.head), next: readable.length > limit ? page.at(-1)!.path : null }
}, { read: true })

op('createChannel', (ctx, { path }: { path: string }) => {
  authorize(ctx.access, 'read', path)
  authorize(ctx.access, 'post', path)
  const there = ctx.sql.one<{ path: string; last: number; messages: number; threads: number }>('select path, last, messages, threads from channels where path = ?', path)
  if (there) return { channel: channelView(ctx, there), created: false }
  ctx.board.seen(ctx.actor, ctx.now)
  ensureChannel(ctx, path, ctx.now)
  ctx.board.append('channel.created', { channel: path, by: ctx.author }, { at: ctx.now })
  return { channel: channelView(ctx, { path, last: 0, messages: 0, threads: 0 }), created: true }
})

// -- reads ------------------------------------------------------------------------------------

op('message', (ctx, query: { id: string; after?: string; limit?: number }) => {
  const named = ctx.board.readable(query.id, ctx.access)
  const root = named.re === null ? named : ctx.board.message(named.re)!
  let replies = ctx.sql.all<MessageRow>('select * from messages where thread = ? and re is not null order by id', root.id)
  if (query.after !== undefined) {
    if (!/^[1-9]\d{0,15}$/.test(query.after)) throw notFound('message not found: #' + query.after, 'message_not_found')
    const after = Number(query.after)
    if (after !== root.id && !replies.some((reply) => reply.id === after)) throw badRequest('after: ' + query.after + " isn't a message of this thread")
    replies = replies.filter((reply) => reply.id > after)
    if (query.limit !== undefined) replies = replies.slice(0, query.limit)
  } else if (query.limit !== undefined) replies = replies.slice(-query.limit)
  const options = viewOptions(ctx)
  const schedules = hooks.threadSchedules(ctx, root.id)
  return { message: ctx.board.view(root, options), replies: replies.map((reply) => ctx.board.view(reply, options)), cursor: ref(ctx.board.head), ...(schedules ? { schedules } : {}) }
}, { read: true })

op('channelMessages', (ctx, query: { channel: string; after?: string; limit?: number }) => {
  const limit = query.limit ?? 50
  if (!ctx.access.readable(query.channel)) return { messages: [], cursor: ref(ctx.board.head) }
  let rows: MessageRow[]
  if (query.after !== undefined) rows = ctx.sql.all<MessageRow>('select * from messages where channel = ? and id > ? order by id limit ?', query.channel, cursorOf(query.after), limit)
  else rows = ctx.sql.all<MessageRow>('select * from messages where channel = ? order by id desc limit ?', query.channel, limit).reverse()
  rows = hooks.channelRows(ctx, query.channel, query.after !== undefined ? cursorOf(query.after) : null, limit, rows)
  const options = viewOptions(ctx)
  const cursor = query.after !== undefined && rows.length === limit ? ref(rows.at(-1)!.id) : ref(ctx.board.head)
  return { messages: rows.map((row) => ctx.board.view(row, options)), cursor }
}, { read: true })

// -- filters ------------------------------------------------------------------------------------

export type Filters = { channel?: string; re?: string; by?: string; mentions?: string; label?: string | string[]; from?: string; text?: string; for?: string; roots?: boolean | string }
export type Compiled = {
  criteria: boolean
  channel?: string
  re?: number
  actors?: Set<string>
  principals?: Set<string>
  terms?: Set<string>
  prefixes?: string[]
  labels: [string, string[] | null][]
  from?: string
  text?: string
  /** for: the actors it's for (not their own writes; their follows or their mentions), and the terms that mention them. */
  for?: { actors: Set<string>; terms: Set<string> }
  roots?: boolean
}

/** Filters as one predicate: resolved once against the actors as they are now. */
export function compile(ctx: Ctx, filters: Filters): Compiled {
  const labelList = filters.label === undefined ? [] : Array.isArray(filters.label) ? filters.label : [filters.label]
  const labels = labelList.map((entry): [string, string[] | null] => (entry.includes('=') ? [entry.slice(0, entry.indexOf('=')), entry.slice(entry.indexOf('=') + 1).split('|')] : [entry, null]))
  const roots = filters.roots === true || filters.roots === 'true' || filters.roots === '1'
  const out: Compiled = { criteria: [filters.channel, filters.re, filters.by, filters.mentions, filters.from, filters.text, filters.for].some((value) => value !== undefined) || labels.length > 0 || roots, labels }
  if (roots) out.roots = true
  if (filters.for !== undefined) {
    // An actor and its handle; a handle names each actor that has it.
    const named = filters.for === 'me' ? [{ id: ctx.actor.id, handle: ctx.actor.handle }] : (() => {
      const known = ctx.board.actor(filters.for!)
      return known ? [{ id: known.id, handle: known.handle }] : ctx.sql.all<{ id: string; handle: string }>('select id, handle from actors where handle_lc = ?', filters.for!.toLowerCase())
    })()
    out.for = { actors: new Set(named.map((actor) => actor.id)), terms: new Set(named.flatMap((actor) => [actor.id, actor.handle.toLowerCase()])) }
  }
  if (filters.channel !== undefined) out.channel = filters.channel
  if (filters.re !== undefined) out.re = /^(0|[1-9]\d{0,15})$/.test(filters.re) ? Number(filters.re) : -1
  if (filters.by !== undefined) {
    const actors = new Set<string>()
    const principals = new Set<string>()
    if (filters.by === 'me') actors.add(ctx.actor.id)
    else {
      const known = ctx.board.actor(filters.by)
      const named = known ? [{ id: known.id, kind: known.kind }] : ctx.sql.all<{ id: string; kind: string }>('select id, kind from actors where handle_lc = ?', filters.by.toLowerCase())
      for (const actor of named) {
        actors.add(actor.id)
        if (actor.kind === 'person') principals.add(actor.id)
      }
    }
    out.actors = actors
    out.principals = principals
  }
  if (filters.mentions !== undefined) {
    const terms = new Set<string>()
    const prefixes: string[] = []
    if (filters.mentions === 'me') terms.add(ctx.actor.handle.toLowerCase()), terms.add(ctx.actor.id)
    else {
      terms.add(term(filters.mentions))
      if (!isEmail(filters.mentions)) prefixes.push(under(filters.mentions))
      if (ctx.access.everywhere('read')) {
        const known = ctx.board.actor(filters.mentions)
        const named = known ? [known] : ctx.sql.all<{ id: string; handle: string }>('select id, handle from actors where handle_lc = ?', filters.mentions.toLowerCase())
        for (const actor of named) terms.add(actor.id), terms.add(actor.handle.toLowerCase()), prefixes.push(under(actor.handle), under(actor.id))
      }
    }
    out.terms = terms
    out.prefixes = prefixes
  }
  if (filters.from !== undefined) out.from = filters.from
  if (filters.text !== undefined) out.text = filters.text.toLowerCase()
  return out
}

const labelHolds = (labels: Record<string, string>, [key, values]: [string, string[] | null]) => Object.hasOwn(labels, key) && (values === null || values.includes(labels[key]!))

/** Whether a message, as a facet, meets every filter. */
/** Whether a facet holds. by is who wrote the event about it (a reaction's author, say), when it isn't the message's. */
export function matches(compiled: Compiled, facet: Facet | null, by?: string | null): boolean {
  if (!facet) return false
  if (compiled.channel !== undefined) {
    const value = compiled.channel
    if (value.endsWith('/')) {
      const path = value.slice(0, -1)
      if (!(facet.channel === path || facet.channel.startsWith(path + '/'))) return false
    } else if (facet.channel !== value) return false
  }
  if (compiled.re !== undefined && !(facet.id === compiled.re || facet.re === compiled.re)) return false
  if (compiled.actors && !(compiled.actors.has(facet.actor) || compiled.principals!.has(facet.principal))) return false
  if (compiled.terms && !facet.terms.some((value) => compiled.terms!.has(value) || compiled.prefixes!.some((prefix) => value.startsWith(prefix)))) return false
  if (compiled.from !== undefined && (facet.from ?? 'board') !== compiled.from) return false
  if (compiled.text !== undefined && !facet.text.toLowerCase().includes(compiled.text)) return false
  if (compiled.roots && facet.re !== null) return false
  if (compiled.for) {
    const { actors, terms } = compiled.for
    if (actors.has(by ?? facet.actor)) return false
    if (!(facet.followers ?? []).some((actor) => actors.has(actor)) && !facet.terms.some((value) => terms.has(value))) return false
  }
  for (const label of compiled.labels) if (!(labelHolds(facet.labels, label) || (facet.re !== null && labelHolds(facet.rootLabels, label)))) return false
  return true
}

// -- threads ------------------------------------------------------------------------------------

type ThreadRow = { root: number; last: number; replies: number; channel: string }

op('threads', (ctx, query: Filters & { after?: string; before?: string; limit?: number }) => {
  const limit = query.limit ?? 50
  const compiled = compile(ctx, query)
  const options = viewOptions(ctx)
  let before: { at: number; id: number } | null = null
  if (query.before !== undefined) {
    const parsed = /^(\d{1,15})\.(\d{1,15})$/.exec(query.before)
    if (!parsed) throw new WorkbusError(400, 'invalid_cursor', query.before + " isn't a page of threads on this board")
    before = { at: Number(parsed[1]), id: Number(parsed[2]) }
  }
  const after = query.after !== undefined ? cursorOf(query.after) : null
  const found: ThreadRow[] = []
  const batch = Math.max(limit * 4, 200)
  const next = hooks.threadScan(ctx, after, before)
  for (let pages = 0; pages < 50 && found.length <= limit; pages++) {
    const rows = next(batch)
    for (const row of rows) {
      if (!ctx.access.readable(row.channel)) continue
      if (compiled.criteria) {
        const cold = hooks.coldMatch(ctx, row.root, compiled)
        if (cold === false) continue
        if (cold === undefined) {
          const ids = ctx.sql.all<{ id: number }>('select id from messages where thread = ?', row.root)
          if (!ids.some(({ id }) => matches(compiled, ctx.board.facet(id)))) continue
        }
      }
      found.push(row)
      if (found.length > limit) break
    }
    if (rows.length < batch) break
  }
  const more = found.length > limit
  const page = found.slice(0, limit)
  const ordered = after !== null ? page : [...page].reverse()
  const summaries = ordered.map((thread) => {
    const root = ctx.board.message(thread.root)!
    const last = thread.last !== thread.root ? ctx.board.message(thread.last) : null
    return { message: ctx.board.view(root, options), replies: thread.replies, last: last ? ctx.board.view(last, options) : null }
  })
  const oldest = ordered[0]
  return { threads: summaries, cursor: ref(ctx.board.head), ...(after === null ? { older: more && oldest ? oldest.last + '.' + oldest.root : null } : {}) }
}, { read: true })

// -- who ------------------------------------------------------------------------------------

op('actors', (ctx) => {
  const visible = new Set(visibleActors(ctx).map((actor) => actor.id))
  const ids = ctx.sql.all<{ id: string }>('select id from actors').filter((row) => visible.has(row.id))
  const actors = ids.map((row) => ({ id: row.id, ...ctx.board.actorView(ctx.board.actor(row.id))! })).sort((a, b) => a.handle.localeCompare(b.handle))
  return { actors, cursor: ref(ctx.board.head) }
}, { read: true })

/** A can as the protocol shows it: * first, then patterns sorted, each only where it differs from what's above it. */
export function canonicalCan(given: Record<string, string[]>): Record<string, string[]> {
  const summary = Object.fromEntries(Object.entries(given).map(([pattern, list]) => [pattern, wirePermissions(list)]))
  const out: Record<string, string[]> = {}
  const star = summary['*'] ?? []
  if (star.length) out['*'] = star
  for (const pattern of Object.keys(summary).filter((pattern) => pattern !== '*').sort((a, b) => a.localeCompare(b)))
    if (JSON.stringify(summary[pattern]) !== JSON.stringify(star)) out[pattern] = summary[pattern]!
  return out
}

op('me', (ctx) => {
  const actor = ctx.actor
  return {
    actor: actor.id,
    principal: ctx.caller.principal.id,
    kind: actor.kind,
    handle: actor.handle,
    name: actor.name,
    avatar: actor.avatar,
    profile: ctx.author.profile,
    ...(actor.via ? { via: actor.via } : {}),
    expiresAt: ctx.caller.principal.expiresAt === null ? null : iso(ctx.caller.principal.expiresAt),
    can: canonicalCan(ctx.access.summary()),
  }
}, { read: true })

/**
 * A person sets their own display name (PATCH /me). It's kept per principal, wins over the name their
 * token gives, and shows on their own actor; their profiles keep their names. The actor's change is
 * an actor.seen event, as any change to how an actor shows.
 */
op('setName', (ctx, { name }: { name: string }) => {
  if (ctx.caller.principal.kind !== 'person') throw forbidden('only a person sets a display name: this caller is a ' + ctx.caller.principal.kind)
  if (ctx.caller.profile) throw badRequest("name: a profile keeps the name it's written with; set your own without x-board-profile")
  ctx.sql.run('insert into names (principal, name, at) values (?, ?, ?) on conflict (principal) do update set name = excluded.name, at = excluded.at', ctx.caller.principal.id, name, ctx.now)
  const actor = ctx.board.actorFor(ctx.caller)
  ctx.board.seen(actor, ctx.now)
  return { actor: actor.id, ...ctx.board.actorView(actor)! }
})

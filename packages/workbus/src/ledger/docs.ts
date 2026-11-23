// Docs: a thread whose root holds a long Markdown body, edited in place by section. A task is a
// thread with a state; a doc is a thread with a body. Its replies are its comments, its channel its
// folder, its labels its properties. Edits name sections and are checked per section; the log keeps
// each edit as the sections it changed, with a snapshot every so often.
import { forbidden, badRequest, WorkbusError, conflict, notFound } from '../errors.ts'
import { authorize, iso, ref, type MessageRow } from './core.ts'
import { ensureChannel, labelMessage, postMessage, refuseReserved, settle, writeTerms, type Posting } from './messages.ts'
import { hooks, op, OPS, viewOptions, type Ctx } from './ops.ts'
import { DDL } from './schema.ts'
import { json } from './sql.ts'
import { mentionTerms } from './text.ts'
import { applyEdit, bodyOf, diff, EditError, merge, parseDoc, replay, type Meta, type Patch, type Section, type SectionEdit } from './doctext.ts'
import { track } from './doctrack.ts'
import { satelliteKey } from '../sync/provider.ts'
import { attach } from './sync.ts'

/**
 * What a sync's own write carries, so its courier doesn't echo it back: only a doc it created, which
 * the platform holds as it is. An edit it imported is a merge, which can hold what the platform's
 * copy lacks, so it goes back (a provider writes nothing when its copy already says it).
 */
const fromOf = (ctx: Ctx) => {
  const key = satelliteKey(ctx.caller)
  return key ? { from: key } : {}
}

/** Attaches a doc's thread to each sync that keeps its channel in step: its courier writes the doc there (not back to the sync it came from). */
function attachSyncs(ctx: Ctx, row: MessageRow, path: string) {
  for (const targetOf of ctx.board.docTargets) {
    const prefix = targetOf(path)
    if (prefix !== null) attach(ctx, row, prefix + ':' + row.id, 'thread', 'doc', fromOf(ctx))
  }
}

/** A doc's body, in bytes of UTF-8 (a message stays at 10,000 characters). */
export const DOC_BODY_MAX = 512 * 1024
/** A snapshot follows every this many edits, so reading an old revision replays at most these. */
export const SNAPSHOT_EVERY = 64
/** An edit whose changed sections pass this keeps only their keys, and a snapshot follows it. */
export const LARGE_EDIT = 64 * 1024
/** Views show the outline to this heading level unless asked for more. */
export const OUTLINE_DEPTH = 3
const SLUG = /^[a-z0-9][a-z0-9_-]{0,127}$/
const REF = /^[1-9]\d{0,15}$/

DDL.push(
  "create table if not exists docs (root integer primary key, channel text not null, slug text not null, title text not null, size integer not null, sections text not null, snapshot integer not null, since integer not null default 0, facet_text text not null, facet_terms text not null default '[]', source text, from_doc integer, created integer not null, unique (channel, slug)) strict",
  // Where each version of a doc is in the log: its edits (and creation) and its snapshots, by seq.
  'create table if not exists doc_versions (root integer not null, seq integer not null, kind text not null, rev integer not null, primary key (root, seq)) strict, without rowid',
  // A proposed edit, waiting on its task (§3.6 of the design): completing the task applies it.
  'create table if not exists doc_proposals (task integer primary key, doc integer not null, edit text not null, revision integer, base text, by text not null, at integer not null) strict',
  'create index if not exists doc_proposals_doc on doc_proposals (doc)',
  // A proposed new doc, waiting on its task: completing the task creates it, as proposed.
  'create table if not exists doc_new_proposals (task integer primary key, channel text not null, slug text not null, body text not null, labels text not null, by text not null, at integer not null) strict',
)

type DocRow = { root: number; channel: string; slug: string; title: string; size: number; sections: string; snapshot: number; since: number; facet_text: string; facet_terms: string; source: string | null; from_doc: number | null; created: number }
type By = { actor: string; principal: string; profile: string | null }

const bytes = (text: string) => new TextEncoder().encode(text).length
const pathOf = (doc: Pick<DocRow, 'channel' | 'slug'>) => doc.channel + '/' + doc.slug
const metasOf = (doc: DocRow) => json<Meta[]>(doc.sections, [])
const revisionOf = (value: string, field = 'revision') => {
  if (!REF.test(value)) throw badRequest(field + ': a revision is a number, like "812", as a doc\'s view gives it')
  return Number(value)
}
const tooLarge = (size: number) => new WorkbusError(400, 'doc_too_large', 'a doc is at most 512 KiB, and this one would be ' + Math.ceil(size / 1024) + ' KiB', { hint: 'split it into several docs and link them with [[path]]' })

/** The doc a reference names (its root's ID, or a path through docAt), readable by the caller. */
function docOf(ctx: Ctx, id: string): { row: MessageRow; doc: DocRow } {
  const row = ctx.board.readable(id, ctx.access)
  const doc = row.re === null && !row.deleted ? ctx.sql.one<DocRow>('select * from docs where root = ?', row.id) : null
  if (!doc) throw notFound('#' + id + " isn't a doc", 'doc_not_found')
  return { row, doc }
}

/** A doc's title: its first H1, or its slug made readable. */
function titleOf(sections: Section[], slug: string): string {
  const h1 = sections.find((section) => section.level === 1 && section.title !== '' && !section.title.includes('{{'))
  if (h1) return h1.title
  const words = slug.replace(/[-_]+/g, ' ').trim()
  return words.charAt(0).toUpperCase() + words.slice(1)
}

export function docView(doc: DocRow, row: MessageRow, depth = OUTLINE_DEPTH) {
  return {
    id: ref(row.id),
    path: pathOf(doc),
    title: doc.title,
    revision: ref(row.revision),
    size: doc.size,
    sections: metasOf(doc).filter((meta) => meta.level > 0 && meta.level <= depth).map((meta) => ({ key: meta.key, title: meta.title, level: meta.level, changed: ref(meta.changed), subtree: ref(meta.subtree) })),
    ...(doc.from_doc !== null ? { from: ref(doc.from_doc) } : {}),
    ...(doc.source !== null ? { source: doc.source } : {}),
    createdAt: iso(doc.created),
  }
}

/** A doc read says when its root is a task too (its state), so a view can show it as an issue. A message view has both faces already. */
function alsoTask<T extends Record<string, unknown>>(ctx: Pick<Ctx, 'sql'>, view: T, root: number): T & { task?: string } {
  const task = ctx.sql.one<{ state: string }>('select state from tasks where root = ?', root)
  return task ? { ...view, task: task.state } : view
}

// -- hooks: how the rest of the board sees a doc --------------------------------------------------

hooks.docRoot = (ctx, root) => Boolean(ctx.sql.one('select 1 as there from docs where root = ?', root))

const viewExtras = hooks.viewExtras
hooks.viewExtras = (ctx, row) => {
  const others = viewExtras(ctx, row)
  if (row.re === null) {
    const doc = ctx.sql.one<DocRow>('select * from docs where root = ?', row.id)
    if (!doc) return others
    const open = ctx.sql.all<{ task: number }>("select p.task from doc_proposals p join tasks t on t.root = p.task where p.doc = ? and t.state in ('waiting', 'ready', 'claimed', 'blocked') order by p.task", row.id)
    return { ...others, doc: { ...docView(doc, row), proposals: open.map((proposal) => ref(proposal.task)) } }
  }
  const key = json<Record<string, string>>(row.labels, {})['board.doc.section']
  if (key === undefined) return others
  const doc = ctx.sql.one<DocRow>('select * from docs where root = ?', row.thread)
  return { ...others, section: { key, detached: !doc || !metasOf(doc).some((meta) => meta.key === key) } }
}

const rootDeleted = hooks.rootDeleted
hooks.rootDeleted = (ctx, root) => {
  rootDeleted(ctx, root)
  ctx.sql.run('delete from docs where root = ?', root)
}

// -- the log: snapshots, versions, and the body at a revision --------------------------------------

function snapshot(ctx: Ctx, root: number, rev: number, body: string) {
  const seq = ctx.board.append('doc.snapshot', { id: root, revision: ref(rev), body }, { at: ctx.now, message: null, thread: root })
  ctx.sql.run("insert into doc_versions (root, seq, kind, rev) values (?, ?, 'snapshot', ?)", root, seq, rev)
  ctx.sql.run('update docs set snapshot = ?, since = 0 where root = ?', rev, root)
}

function eventAt(ctx: Ctx, seq: number): Record<string, unknown> {
  const [row] = hooks.eventRows(ctx, seq - 1, 1, seq)
  if (!row || row.seq !== seq) throw new WorkbusError(500, 'doc_history_missing', 'the event at ' + seq + " isn't in the board's log")
  return JSON.parse(row.payload) as Record<string, unknown>
}

/** The body as it was at a revision: the latest snapshot at or before it, then its edits since. */
export function bodyAt(ctx: Ctx, row: MessageRow, rev: number): string {
  if (rev >= row.revision) return row.text
  const snap = ctx.sql.one<{ seq: number; rev: number }>("select seq, rev from doc_versions where root = ? and kind = 'snapshot' and rev <= ? order by rev desc limit 1", row.id, rev)
  if (!snap) throw badRequest('revision ' + rev + ' is before #' + row.id + ' was a doc', 'invalid_revision')
  let body = eventAt(ctx, snap.seq).body as string
  const edits = ctx.sql.all<{ seq: number }>("select seq from doc_versions where root = ? and kind = 'edit' and seq > ? and seq <= ? order by seq", row.id, snap.rev, rev)
  for (const edit of edits) body = replay(body, eventAt(ctx, edit.seq) as unknown as Patch)
  return body
}

// -- writes ------------------------------------------------------------------------------------

type CreateDoc = { channel?: string; re?: string; slug?: string; body?: string; from?: string; labels?: Record<string, string>; id?: string; mirror?: boolean; propose?: boolean; note?: string }

function fill(text: string, values: { title: string; author: string; date: string }) {
  return text.replaceAll('{{title}}', values.title).replaceAll('{{author}}', values.author).replaceAll('{{date}}', values.date)
}

/** A doc root's labels as its terms index them: with its task's state when it's a task too. */
function termLabels(ctx: Ctx, root: number, labels: Record<string, string>): Record<string, string> {
  const task = ctx.sql.one<{ state: string }>('select state from tasks where root = ?', root)
  return task ? { ...labels, 'board.task': task.state } : labels
}

/** The body a doc starts from: its own, or another doc's as a template, filled in. */
function startingBody(ctx: Ctx, body: { body?: string; from?: string }, slug: string, labels: Record<string, string>): { text: string | undefined; from: number | null } {
  if (body.from === undefined) return { text: body.body, from: null }
  const source = docOf(ctx, body.from)
  for (const [key, value] of Object.entries(json<Record<string, string>>(source.row.labels, {}))) if (key !== 'template' && !key.startsWith('board.')) labels[key] = value
  const title = titleOf(parseDoc(source.row.text), slug)
  return { text: fill(source.row.text, { title, author: ctx.actor.name, date: new Date(ctx.now).toISOString().slice(0, 10) }), from: source.row.id }
}

/**
 * Makes a thread's root a doc where it is (a task gains a body): its channel stays, its text (or a
 * new body) becomes the doc's, and its history as a doc starts here. Its replies are its comments.
 */
function threadBecomesDoc(ctx: Ctx, body: CreateDoc) {
  const row = ctx.board.readable(body.re!, ctx.access)
  if (row.re !== null) throw badRequest('#' + row.id + ' is a reply: a doc is a thread, so name its root, #' + row.re)
  if (row.deleted) throw badRequest('message was deleted', 'message_deleted')
  authorize(ctx.access, 'post', row.channel)
  authorize(ctx.access, 'edit', row.channel)
  refuseReserved(Object.keys(body.labels ?? {}))
  if (Object.keys(body.labels ?? {}).length) authorize(ctx.access, 'label', row.channel)
  // Unnamed, it's named for its root: a task that gains a description needn't be named.
  const slug = body.slug ?? ref(row.id)
  if (!SLUG.test(slug)) throw badRequest('slug: a doc\'s slug is lowercase letters, numbers, _, and -, up to 128, starting with a letter or number', 'invalid_slug')
  const already = ctx.sql.one<DocRow>('select * from docs where root = ?', row.id)
  if (already) throw conflict('already_a_doc', '#' + row.id + ' is a doc already, at ' + pathOf(already))
  if (ctx.sql.one('select 1 as there from docs where channel = ? and slug = ?', row.channel, slug)) throw conflict('slug_taken', row.channel + '/' + slug + ' is a doc already')
  const labels: Record<string, string> = {}
  const start = startingBody(ctx, body, slug, labels)
  const text = start.text === undefined ? row.text : settle(ctx, start.text, row.id).text
  if (text.trim() === '') throw badRequest('body: a doc has a body')
  if (bytes(text) > DOC_BODY_MAX) throw tooLarge(bytes(text))
  const path = row.channel + '/' + slug
  const all = { ...json<Record<string, string>>(row.labels, {}), ...labels, ...(body.labels ?? {}), 'board.doc': path, ...(start.from !== null ? { 'board.doc.from': ref(start.from) } : {}) }
  ctx.board.seen(ctx.actor, ctx.now)
  const before = ctx.board.facet(row.id)
  const seq = ctx.board.reserve()
  const changed = text !== row.text
  ctx.sql.run('update messages set text = ?, text_lower = ?, labels = ?, version = ?, revision = ?, edited_at = ? where id = ?', text, text.toLowerCase(), JSON.stringify(all), seq, seq, changed ? ctx.now : row.edited_at, row.id)
  const sections = parseDoc(text)
  const title = titleOf(sections, slug)
  const facet = [title, ...sections.filter((section) => section.level > 0).map((section) => section.title)].join('\n')
  ctx.sql.run(
    'insert into docs (root, channel, slug, title, size, sections, snapshot, since, facet_text, facet_terms, source, from_doc, created) values (?, ?, ?, ?, ?, ?, ?, 0, ?, ?, null, ?, ?)',
    row.id, row.channel, slug, title, bytes(text), JSON.stringify(track(null, sections, seq)), seq, facet, JSON.stringify(mentionTerms(text)), start.from, ctx.now,
  )
  writeTerms(ctx, { id: row.id, thread: row.thread, text, deleted: 0, labels: termLabels(ctx, row.id, all), attachments: json(row.attachments, []) })
  ctx.board.append('doc.created', { id: row.id, thread: row.thread_key, path, title, ...(start.from !== null ? { template: ref(start.from) } : {}), by: ctx.author, ...fromOf(ctx) }, { at: ctx.now, message: row.id, thread: row.id, before, seq })
  ctx.sql.run("insert into doc_versions (root, seq, kind, rev) values (?, ?, 'edit', ?)", row.id, seq, seq)
  snapshot(ctx, row.id, seq, text)
  ctx.sql.run('update docs set facet_text = ?, facet_terms = ? where root = ?', title, '[]', row.id)
  // A new body changes what a task asks: a claim someone else holds is held, as an edit to it would be.
  if (changed) hooks.rootEdited(ctx, row.id)
  attachSyncs(ctx, ctx.board.message(row.id)!, path)
  return { message: ctx.board.view(ctx.board.message(row.id)!, viewOptions(ctx)) }
}

op('createDoc', (ctx, body: CreateDoc) => {
  if (body.re !== undefined) return threadBecomesDoc(ctx, body)
  if (body.propose) return proposeNew(ctx, body)
  return createNew(ctx, body)
})

/** A new doc at channel/slug, written as the caller: with proposedBy, it's a proposal's, applied by its completer. */
function createNew(ctx: Ctx, body: CreateDoc, proposedBy?: string) {
  const channel = body.channel!
  const slug = body.slug!
  authorize(ctx.access, 'post', channel)
  authorize(ctx.access, 'edit', channel)
  // A mirror of a platform's page: only that platform's sync makes one, and only its imports change it.
  const mirror = body.mirror ? satelliteKey(ctx.caller) : null
  if (body.mirror && mirror === null) throw forbidden('only a sync makes a mirror of a page: create the doc, or set up the sync', 'mirror_needs_sync')
  if (!SLUG.test(slug)) throw badRequest('slug: a doc\'s slug is lowercase letters, numbers, _, and -, up to 128, starting with a letter or number', 'invalid_slug')
  if ((body.body === undefined) === (body.from === undefined)) throw badRequest('a doc starts from its body, or from another doc: pass one of body and from')
  if (body.id !== undefined) {
    const landed = ctx.sql.one<{ id: number }>('select id from messages where client_key = ?', ctx.board.clientKey(channel, body.id, ctx.author.actor))
    const doc = landed ? ctx.sql.one<DocRow>('select * from docs where root = ?', landed.id) : null
    if (doc && doc.channel === channel && doc.slug === slug) return { message: ctx.board.view(ctx.board.message(doc.root)!, viewOptions(ctx)) }
  }
  if (ctx.sql.one('select 1 as there from docs where channel = ? and slug = ?', channel, slug)) throw conflict('slug_taken', channel + '/' + slug + ' is a doc already')
  let labels: Record<string, string> = {}
  const start = startingBody(ctx, body, slug, labels)
  const text = start.text ?? ''
  const from = start.from
  labels = { ...labels, ...(body.labels ?? {}) }
  if (text.trim() === '') throw badRequest('body: a doc has a body')
  if (bytes(text) > DOC_BODY_MAX) throw tooLarge(bytes(text))
  const path = channel + '/' + slug
  const posting: Posting = { channel, text, labels, ...(body.id !== undefined ? { id: body.id } : {}) }
  const { row, mentions } = postMessage(ctx, posting, { textMax: DOC_BODY_MAX, boardLabels: { 'board.doc': path, ...(from !== null ? { 'board.doc.from': ref(from) } : {}) } })
  const sections = parseDoc(row.text)
  const title = titleOf(sections, slug)
  const metas = track(null, sections, row.id)
  const facet = [title, ...sections.filter((section) => section.level > 0).map((section) => section.title)].join('\n')
  ctx.sql.run(
    'insert into docs (root, channel, slug, title, size, sections, snapshot, since, facet_text, facet_terms, source, from_doc, created) values (?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?, ?, ?)',
    row.id, channel, slug, title, bytes(row.text), JSON.stringify(metas), row.id, facet, JSON.stringify(mentionTerms(row.text)), mirror, from, ctx.now,
  )
  // The post's own event keeps the doc's facet, not its body twice.
  ctx.sql.run('update events set facets = ? where seq = ?', JSON.stringify({ before: null, after: ctx.board.facet(row.id) }), row.id)
  const before = ctx.board.facet(row.id)
  ctx.board.append('doc.created', { id: row.id, thread: row.thread_key, path, title, ...(from !== null ? { template: ref(from) } : {}), by: ctx.author, ...(proposedBy ? { proposedBy } : {}), ...fromOf(ctx) }, { at: ctx.now, message: row.id, thread: row.id, before })
  ctx.sql.run("insert into doc_versions (root, seq, kind, rev) values (?, ?, 'edit', ?)", row.id, row.id, row.id)
  snapshot(ctx, row.id, row.id, row.text)
  ctx.sql.run('update docs set facet_text = ?, facet_terms = ? where root = ?', title, '[]', row.id)
  attachSyncs(ctx, ctx.board.message(row.id)!, path)
  return { message: ctx.board.view(ctx.board.message(row.id)!, viewOptions(ctx)), ...(mentions ? { mentions } : {}) }
}

/**
 * A new doc asked for, by someone who may post in its channel (§3.6, for a doc that isn't there yet):
 * a task in the channel, labeled board.doc.proposal=new:<path>, that shows the body it would have.
 * Completing the task creates the doc as proposed (by its completer, who needs edit there); failing
 * or canceling it drops it. Its blocks are checked now, as a create's would be.
 */
function proposeNew(ctx: Ctx, body: CreateDoc) {
  const channel = body.channel!
  const slug = body.slug!
  authorize(ctx.access, 'post', channel)
  if (body.mirror) throw badRequest("mirror: a sync makes a mirror itself; it isn't proposed", 'invalid_request')
  if (!SLUG.test(slug)) throw badRequest('slug: a doc\'s slug is lowercase letters, numbers, _, and -, up to 128, starting with a letter or number', 'invalid_slug')
  if ((body.body === undefined) === (body.from === undefined)) throw badRequest('a doc starts from its body, or from another doc: pass one of body and from')
  if (ctx.sql.one('select 1 as there from docs where channel = ? and slug = ?', channel, slug)) throw conflict('slug_taken', channel + '/' + slug + ' is a doc already')
  let labels: Record<string, string> = {}
  const start = startingBody(ctx, body, slug, labels)
  const text = start.text ?? ''
  labels = { ...labels, ...(start.from !== null ? { 'board.doc.from': ref(start.from) } : {}), ...(body.labels ?? {}) }
  if (text.trim() === '') throw badRequest('body: a doc has a body')
  if (bytes(text) > DOC_BODY_MAX) throw tooLarge(bytes(text))
  hooks.checkBlocks(ctx, text)
  const path = channel + '/' + slug
  const shown = 'Proposed new doc [[' + path + ']]: ' + titleOf(parseDoc(text), slug) + '.' + (body.note ? '\n\n' + body.note.trim() : '') + '\n\nComplete this task to create it; fail or cancel it to drop it.'
  // The body it would have, when it fits beside the proposal in one message.
  const withBody = shown + '\n\n---\n\n' + text
  const made = OPS.createTask!(ctx, { channel, text: [...withBody].length <= 10_000 ? withBody : shown + '\n\n(The body is ' + Math.ceil(bytes(text) / 1024) + ' KiB: too long to show here.)' }) as { task: { id: string } }
  const task = Number(made.task.id)
  labelMessage(ctx, ctx.board.message(task)!, { set: { 'board.doc.proposal': 'new:' + path } }, ctx.author)
  ctx.sql.run('insert into doc_new_proposals (task, channel, slug, body, labels, by, at) values (?, ?, ?, ?, ?, ?, ?)', task, channel, slug, text, JSON.stringify(labels), ctx.actor.id, ctx.now)
  return { proposal: ctx.board.view(ctx.board.message(task)!, viewOptions(ctx)) }
}

/** Writes a doc's new body: the root's text, its sections' revisions, one doc.edited event. */
function commit(ctx: Ctx, row: MessageRow, doc: DocRow, next: Section[], extra: { base: string | null; by: By; proposedBy?: string }): number {
  const text = bodyOf(next)
  if (text === row.text) return row.revision
  if (bytes(text) > DOC_BODY_MAX) throw tooLarge(bytes(text))
  const previous = parseDoc(row.text)
  const patch = diff(previous, next)
  const before = ctx.board.facet(row.id)
  const seq = ctx.board.reserve()
  const metas = track(metasOf(doc), next, seq)
  const title = titleOf(next, doc.slug)
  const titles = new Map([...previous, ...next].map((section) => [section.key, section.title]))
  const facetText = [title, ...patch.changes.map((change) => titles.get(change.section) ?? '').filter(Boolean)].join('\n')
  const facetTerms = mentionTerms(patch.changes.map((change) => change.text ?? '').join('\n'))
  ctx.sql.run('update messages set text = ?, text_lower = ?, edited_at = ?, version = ?, revision = ? where id = ?', text, text.toLowerCase(), ctx.now, seq, seq, row.id)
  ctx.sql.run('update docs set title = ?, size = ?, sections = ?, since = since + 1, facet_text = ?, facet_terms = ? where root = ?', title, bytes(text), JSON.stringify(metas), facetText, JSON.stringify(facetTerms), row.id)
  writeTerms(ctx, { id: row.id, thread: row.thread, text, deleted: 0, labels: termLabels(ctx, row.id, json(row.labels, {})), attachments: json(row.attachments, []) })
  const changed = patch.changes.reduce((sum, change) => sum + (change.text?.length ?? 0), 0)
  const large = changed > LARGE_EDIT
  const payload: Record<string, unknown> = {
    id: row.id,
    thread: row.thread_key,
    revision: ref(seq),
    base: extra.base,
    changes: large ? patch.changes.map((change) => ({ section: change.section, op: change.op })) : patch.changes,
    ...(large ? { large: true } : { layout: patch.layout }),
    by: extra.by,
    ...(extra.proposedBy ? { proposedBy: extra.proposedBy } : {}),
  }
  ctx.board.append('doc.edited', payload, { at: ctx.now, message: row.id, thread: row.id, before: before ? { ...before, text: facetText, terms: facetTerms } : null, seq })
  ctx.sql.run("insert into doc_versions (root, seq, kind, rev) values (?, ?, 'edit', ?)", row.id, seq, seq)
  ctx.sql.run('update docs set facet_text = ?, facet_terms = ? where root = ?', title, '[]', row.id)
  if (large || doc.since + 1 >= SNAPSHOT_EVERY) snapshot(ctx, row.id, seq, text)
  return seq
}

export type EditDoc = { id: string; revision?: string; base?: string; edits?: SectionEdit[]; body?: string; merge?: boolean; propose?: boolean; note?: string }

const sectionConflict = (key: string, since: number, rev: number) =>
  new WorkbusError(409, 'section_conflict', JSON.stringify(key) + ' changed at revision ' + since + ', after revision ' + rev + ': read it again and redo your change', { data: { section: key, revision: ref(since) } })

/** Settles mentions in an edit's text: @handle to @[actor-id], as a post's. */
function settled(ctx: Ctx, row: MessageRow, edit: SectionEdit): SectionEdit {
  if (!('text' in edit) || edit.text === undefined) return edit
  return { ...edit, text: settle(ctx, edit.text, row.thread).text } as SectionEdit
}

/** Checks an edit against the doc as it is and applies it: the new revision. */
function applyDocEdit(ctx: Ctx, row: MessageRow, doc: DocRow, body: EditDoc, by: By, proposedBy?: string): { revision: number; merged?: boolean } {
  // A mirror changes only by its sync's imports.
  if (doc.source !== null && satelliteKey(ctx.caller) !== doc.source) throw conflict('doc_mirrored', pathOf(doc) + ' mirrors a page in ' + doc.source + ': edit it there')
  const rev = body.revision !== undefined ? revisionOf(body.revision) : null
  if (body.edits !== undefined) {
    if (rev === null) throw badRequest('revision: a section edit names the revision you read, so a section changed since then is refused rather than overwritten')
    if (body.edits.length === 0) throw badRequest('edits: nothing to change')
    const metas = new Map(metasOf(doc).map((meta) => [meta.key, meta]))
    let sections = parseDoc(row.text)
    for (const raw of body.edits) {
      const edit = settled(ctx, row, raw)
      const key = 'section' in edit ? edit.section : 'after' in edit ? edit.after : edit.remove
      const meta = metas.get(key)
      if (!meta) {
        if (rev < row.revision) throw new WorkbusError(409, 'section_conflict', JSON.stringify(key) + " isn't in the doc now: it was renamed or removed after revision " + rev, { data: { section: key, revision: ref(row.revision) } })
        throw notFound('no section ' + JSON.stringify(key) + ' in ' + pathOf(doc), 'section_not_found')
      }
      const deep = 'remove' in edit || ('section' in edit && edit.subtree === true)
      const since = 'after' in edit ? 0 : deep ? meta.subtree : meta.changed
      if (since > rev) throw sectionConflict(key, since, rev)
      try {
        sections = applyEdit(sections, edit)
      } catch (error) {
        if (error instanceof EditError) throw new WorkbusError(error.status, error.code, error.message, error.section !== undefined ? { data: { section: error.section } } : {})
        throw error
      }
    }
    return { revision: commit(ctx, row, doc, sections, { base: ref(rev), by, ...(proposedBy ? { proposedBy } : {}) }) }
  }
  if (body.body === undefined) throw badRequest('an edit gives edits, or a whole body')
  const text = settle(ctx, body.body, row.thread).text
  if (!body.merge) {
    if (rev === null) throw badRequest('revision: a whole-body edit names the revision you read')
    if (rev !== row.revision) throw new WorkbusError(409, 'revision_conflict', pathOf(doc) + ' was edited after revision ' + rev + ": it's at " + row.revision + ': read it again, or send merge: true', { data: { revision: ref(row.revision) } })
    return { revision: commit(ctx, row, doc, parseDoc(text), { base: ref(rev), by, ...(proposedBy ? { proposedBy } : {}) }) }
  }
  if (rev === null && body.base === undefined) throw badRequest('a merge needs what you started from: the revision you read, or base, the text')
  const base = body.base ?? bodyAt(ctx, row, rev!)
  const merged = merge(base, text, row.text)
  if ('conflicts' in merged) throw new WorkbusError(409, 'merge_conflict', 'these sections changed both in your text and in the doc: ' + merged.conflicts.map((key) => JSON.stringify(key)).join(', '), { data: { sections: merged.conflicts, revision: ref(row.revision) } })
  return { revision: commit(ctx, row, doc, parseDoc(merged.body), { base: body.base !== undefined ? 'text' : ref(rev!), by, ...(proposedBy ? { proposedBy } : {}) }), merged: true }
}

const answer = (ctx: Ctx, root: number) => {
  const row = ctx.board.message(root)!
  const doc = ctx.sql.one<DocRow>('select * from docs where root = ?', root)!
  return { doc: alsoTask(ctx, docView(doc, row), root), revision: ref(row.revision) }
}

op('editDoc', (ctx, body: EditDoc) => {
  const { row, doc } = docOf(ctx, body.id)
  if (body.propose) return propose(ctx, row, doc, body)
  authorize(ctx.access, 'edit', row.channel)
  ctx.board.seen(ctx.actor, ctx.now)
  const done = applyDocEdit(ctx, row, doc, body, ctx.author)
  return { ...answer(ctx, row.id), ...(done.merged ? { merged: true } : {}) }
})

// -- proposals: an edit someone without edit asks for, as a task ----------------------------------

function propose(ctx: Ctx, row: MessageRow, doc: DocRow, body: EditDoc) {
  authorize(ctx.access, 'post', row.channel)
  if (doc.source !== null) throw conflict('doc_mirrored', pathOf(doc) + ' mirrors a page in ' + doc.source + ': edit it there')
  const { id: _id, propose: _propose, note, ...edit } = body
  if (edit.edits === undefined && edit.body === undefined) throw badRequest('a proposal gives edits, or a whole body')
  if (edit.edits !== undefined && edit.revision === undefined) throw badRequest('revision: a proposed section edit names the revision it was made against')
  if (edit.edits !== undefined) {
    const keys = new Set(metasOf(doc).map((meta) => meta.key))
    for (const one of edit.edits) {
      const key = 'section' in one ? one.section : 'after' in one ? one.after : one.remove
      if (!keys.has(key)) throw notFound('no section ' + JSON.stringify(key) + ' in ' + pathOf(doc), 'section_not_found')
    }
  }
  const what = edit.edits !== undefined
    ? edit.edits.map((one) => ('section' in one ? 'change ' + JSON.stringify(one.section) : 'after' in one ? 'add a section after ' + JSON.stringify(one.after || '(the top)') : 'remove ' + JSON.stringify(one.remove))).join('; ')
    : 'replace the whole body'
  const text = 'Proposed change to [[' + pathOf(doc) + ']]: ' + what + '.' + (note ? '\n\n' + note.trim() : '') + '\n\nComplete this task to apply it; fail or cancel it to drop it.'
  const made = OPS.createTask!(ctx, { channel: doc.channel, text }) as { task: { id: string } }
  const task = Number(made.task.id)
  labelMessage(ctx, ctx.board.message(task)!, { set: { 'board.doc.proposal': ref(row.id) } }, ctx.author)
  ctx.sql.run('insert into doc_proposals (task, doc, edit, revision, base, by, at) values (?, ?, ?, ?, ?, ?, ?)', task, row.id, JSON.stringify(edit), edit.revision !== undefined ? revisionOf(edit.revision) : null, edit.base ?? null, ctx.actor.id, ctx.now)
  return { proposal: ctx.board.view(ctx.board.message(task)!, viewOptions(ctx)) }
}

hooks.taskCompleting = (ctx, root) => {
  const asked = ctx.sql.one<{ channel: string; slug: string; body: string; labels: string; by: string }>('select channel, slug, body, labels, by from doc_new_proposals where task = ?', root)
  if (asked) {
    // Created as proposed, by whoever completes it; a slug taken since is refused, and the task stays open.
    createNew(ctx, { channel: asked.channel, slug: asked.slug, body: asked.body, labels: json<Record<string, string>>(asked.labels, {}) }, asked.by)
    return
  }
  const proposal = ctx.sql.one<{ doc: number; edit: string; revision: number | null; base: string | null; by: string }>('select doc, edit, revision, base, by from doc_proposals where task = ?', root)
  if (!proposal) return
  const { row, doc } = docOf(ctx, ref(proposal.doc))
  authorize(ctx.access, 'edit', row.channel)
  const edit = JSON.parse(proposal.edit) as EditDoc
  applyDocEdit(ctx, row, doc, { ...edit, id: ref(row.id), ...(proposal.revision !== null ? { revision: ref(proposal.revision) } : {}), ...(proposal.base !== null ? { base: proposal.base } : {}) }, ctx.author, proposal.by)
}

// -- moving --------------------------------------------------------------------------------------

op('moveDoc', (ctx, body: { id: string; channel?: string; slug?: string }) => {
  const { row, doc } = docOf(ctx, body.id)
  const channel = body.channel ?? doc.channel
  const slug = body.slug ?? doc.slug
  authorize(ctx.access, 'edit', doc.channel)
  authorize(ctx.access, 'edit', channel)
  if (!SLUG.test(slug)) throw badRequest('slug: a doc\'s slug is lowercase letters, numbers, _, and -, up to 128, starting with a letter or number', 'invalid_slug')
  if (channel === doc.channel && slug === doc.slug) return answer(ctx, row.id)
  // Its earlier events were seen where it was: a move across a private channel's edge would show its later text there.
  if (channel !== doc.channel && JSON.stringify(ctx.board.partiesOf(channel)) !== JSON.stringify(ctx.board.partiesOf(doc.channel)))
    throw conflict('private_move', "a doc can't move into or out of a private channel, or between private channels with different parties")
  if (ctx.sql.one('select 1 as there from docs where channel = ? and slug = ?', channel, slug)) throw conflict('slug_taken', channel + '/' + slug + ' is a doc already')
  const from = pathOf(doc)
  const to = channel + '/' + slug
  ctx.board.seen(ctx.actor, ctx.now)
  const before = ctx.board.facet(row.id)
  const seq = ctx.board.reserve()
  if (channel !== doc.channel) {
    ensureChannel(ctx, channel, ctx.now)
    const counts = ctx.sql.one<{ n: number }>('select count(*) as n from messages where thread = ?', row.id)!
    ctx.sql.run('update messages set channel = ? where thread = ?', channel, row.id)
    ctx.sql.run('update threads set channel = ? where root = ?', channel, row.id)
    ctx.sql.run('update tasks set channel = ? where root in (select id from messages where thread = ?)', channel, row.id)
    ctx.sql.run('update channels set messages = max(messages - ?, 0), threads = max(threads - 1, 0) where path = ?', counts.n, doc.channel)
    ctx.sql.run('update channels set messages = messages + ?, threads = threads + 1, last = max(last, ?) where path = ?', counts.n, seq, channel)
    hooks.docMoved(ctx, row, doc.channel, channel)
  }
  const labels = { ...json<Record<string, string>>(row.labels, {}), 'board.doc': to }
  ctx.sql.run('update messages set labels = ?, version = ? where id = ?', JSON.stringify(labels), seq, row.id)
  // A title that comes from the slug follows it.
  ctx.sql.run('update docs set channel = ?, slug = ?, title = ? where root = ?', channel, slug, titleOf(parseDoc(row.text), slug), row.id)
  writeTerms(ctx, { id: row.id, thread: row.thread, text: row.text, deleted: 0, labels: termLabels(ctx, row.id, labels), attachments: json(row.attachments, []) })
  ctx.board.append('doc.moved', { id: row.id, thread: row.thread_key, path: from, to, by: ctx.author, ...fromOf(ctx) }, { at: ctx.now, message: row.id, thread: row.id, before, seq })
  attachSyncs(ctx, ctx.board.message(row.id)!, to)
  return answer(ctx, row.id)
})

// -- comments on a section -------------------------------------------------------------------------

const post = OPS.post!
op('post', (ctx, body: Posting) => {
  if (body.section === undefined) return post(ctx, body)
  const target = ctx.board.readable(body.re!, ctx.access)
  const root = target.re === null ? target : ctx.board.message(target.re)!
  const doc = ctx.sql.one<DocRow>('select * from docs where root = ?', root.id)
  if (!doc) throw badRequest('section: #' + root.id + " isn't a doc, so a reply there names no section", 'not_a_doc')
  if (!metasOf(doc).some((meta) => meta.key === body.section)) throw notFound('no section ' + JSON.stringify(body.section) + ' in ' + pathOf(doc), 'section_not_found')
  const { section, ...rest } = body
  const { row, mentions } = postMessage(ctx, rest, { boardLabels: { 'board.doc.section': section } })
  return { message: ctx.board.view(row, viewOptions(ctx)), ...(mentions ? { mentions } : {}) }
})

// -- reads --------------------------------------------------------------------------------------

function read(ctx: Ctx, row: MessageRow, doc: DocRow, query: { section?: string; revision?: string; depth?: number }) {
  const depth = query.depth ?? OUTLINE_DEPTH
  const view = alsoTask(ctx, docView(doc, row, depth), row.id)
  const rev = query.revision !== undefined ? revisionOf(query.revision) : null
  const body = rev === null ? row.text : bodyAt(ctx, row, rev)
  const at = rev === null ? view : { ...view, revision: ref(rev) }
  if (query.section === undefined) return { doc: at, body }
  const sections = parseDoc(body)
  const index = sections.findIndex((section) => section.key === query.section)
  if (index < 0) throw notFound('no section ' + JSON.stringify(query.section) + ' in ' + pathOf(doc) + (rev !== null ? ' at revision ' + rev : ''), 'section_not_found')
  const section = sections[index]!
  const meta = metasOf(doc).find((one) => one.key === section.key)
  let end = index + 1
  while (end < sections.length && section.level > 0 && sections[end]!.level > section.level) end++
  return {
    doc: at,
    section: {
      key: section.key,
      title: section.title,
      level: section.level,
      text: section.own,
      subtree: sections.slice(index + 1, end).map((child) => child.head + child.own).join(''),
      ...(rev === null && meta ? { changed: ref(meta.changed), subtreeChanged: ref(meta.subtree) } : {}),
    },
  }
}

op('doc', (ctx, query: { id: string; section?: string; revision?: string; depth?: number }) => {
  const { row, doc } = docOf(ctx, query.id)
  return read(ctx, row, doc, query)
}, { read: true })

op('docAt', (ctx, query: { path: string; section?: string; revision?: string; depth?: number }) => {
  const split = query.path.lastIndexOf('/')
  const found = split > 0 ? ctx.sql.one<DocRow>('select * from docs where channel = ? and slug = ?', query.path.slice(0, split), query.path.slice(split + 1)) : null
  if (!found || !ctx.access.readable(found.channel)) throw notFound('no doc at ' + query.path, 'doc_not_found')
  const { row, doc } = docOf(ctx, ref(found.root))
  return read(ctx, row, doc, query)
}, { read: true })

op('docHistory', (ctx, query: { id: string; after?: string; limit?: number }) => {
  const { row } = docOf(ctx, query.id)
  const after = query.after !== undefined ? revisionOf(query.after, 'after') : 0
  const limit = query.limit ?? 100
  const versions = ctx.sql.all<{ seq: number }>("select seq from doc_versions where root = ? and kind = 'edit' and seq > ? order by seq limit ?", row.id, after, limit + 1)
  const page = versions.slice(0, limit)
  const edits = page.map(({ seq }) => {
    const [event] = hooks.eventRows(ctx, seq - 1, 1, seq)
    const payload = JSON.parse(event!.payload) as { by?: By; changes?: { section: string; op: string }[]; base?: string | null; proposedBy?: string; channel?: string }
    const by = payload.by ? { actor: payload.by.actor, principal: payload.by.principal, profile: payload.by.profile ?? null } : null
    const kind = event!.type === 'message.posted' || event!.type === 'doc.created' ? 'created' : 'edited'
    return {
      revision: ref(seq),
      kind,
      at: iso(event!.at),
      by,
      ...(kind === 'edited' ? { base: payload.base ?? null, sections: (payload.changes ?? []).map((change) => ({ section: change.section, op: change.op })) } : {}),
      ...(payload.proposedBy ? { proposedBy: payload.proposedBy } : {}),
    }
  })
  return { edits, cursor: page.length ? ref(page.at(-1)!.seq) : (query.after ?? null), more: versions.length > limit }
}, { read: true })

op('docDiff', (ctx, query: { id: string; from: string; to?: string }) => {
  const { row } = docOf(ctx, query.id)
  const from = revisionOf(query.from, 'from')
  const to = query.to !== undefined ? revisionOf(query.to, 'to') : row.revision
  const before = new Map(parseDoc(bodyAt(ctx, row, from)).map((section) => [section.key, section]))
  const after = parseDoc(bodyAt(ctx, row, to))
  const keys = new Set(after.map((section) => section.key))
  const sections: Record<string, unknown>[] = []
  for (const section of after) {
    const was = before.get(section.key)
    const now = section.head + section.own
    if (!was) sections.push({ section: section.key, change: 'inserted', after: now })
    else if (was.head + was.own !== now) sections.push({ section: section.key, change: 'edited', before: was.head + was.own, after: now })
  }
  for (const [key, was] of before) if (!keys.has(key)) sections.push({ section: key, change: 'removed', before: was.head + was.own })
  return { from: ref(from), to: ref(to), sections }
}, { read: true })

op('docBacklinks', (ctx, query: { id: string }) => {
  const { row } = docOf(ctx, query.id)
  const term = 'k:' + row.id
  const found = ctx.sql.all<{ message: number; root: number }>('select message, root from terms where term = ? union select message, root from frozen_files where term = ? order by message', term, term)
  const links: Record<string, unknown>[] = []
  for (const { message } of found) {
    const linking = ctx.board.message(message)
    if (!linking || linking.deleted || !ctx.access.readable(linking.channel)) continue
    const doc = linking.re === null ? ctx.sql.one<DocRow>('select * from docs where root = ?', linking.id) : null
    const summary = doc ? doc.title : linking.text.replace(/\s+/g, ' ').trim().slice(0, 140)
    links.push({ id: ref(linking.id), thread: ref(linking.thread), channel: linking.channel, kind: doc ? 'doc' : linking.re === null ? 'thread' : 'reply', ...(doc ? { path: pathOf(doc) } : {}), summary })
  }
  // The docs made from it, when it's a template.
  for (const made of ctx.sql.all<DocRow>('select * from docs where from_doc = ? order by root', row.id)) {
    const root = ctx.board.message(made.root)
    if (!root || root.deleted || !ctx.access.readable(root.channel) || links.some((link) => link.id === ref(made.root))) continue
    links.push({ id: ref(made.root), thread: ref(made.root), channel: root.channel, kind: 'doc', path: pathOf(made), via: 'template', summary: made.title })
  }
  return { backlinks: links }
}, { read: true })

// A doc's body as sections: its ATX headings split it, every level counts, and sections nest. Pure:
// parsing, the operations an edit makes, the patch the log keeps, and the three-way merge.
import { createHash } from 'node:crypto'

/** One section in document order. The preamble (text before the first heading) is key "" at level 0. */
export type Section = { key: string; title: string; level: number; head: string; own: string; parent: string | null }
/** What the docs table keeps per section: its revisions are the conflict check. */
export type Meta = { key: string; title: string; level: number; hash: string; changed: number; subtree: number }

const FENCE = /^ {0,3}(\x60{3,}|~{3,})/
const HEADING = /^ {0,3}(#{1,6})(?:[ \t]+(.*?))?(?:[ \t]+#+)?[ \t]*$/

export const raw = (section: Section) => section.head + section.own
export const bodyOf = (sections: Section[]) => sections.map(raw).join('')
export const hashOf = (text: string) => createHash('sha256').update(text).digest('base64url').slice(0, 16)

/** A heading's title as a key segment: lowercase words joined by dashes. */
export function slug(title: string): string {
  const out = title
    .toLowerCase()
    .replace(/<[^>]*>/g, '')
    .replace(/[^\p{L}\p{N}\s-]/gu, '')
    .trim()
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
  return out || 'section'
}

function lines(text: string): string[] {
  return text.match(/[^\n]*\n|[^\n]+$/g) ?? []
}

/** The headings in a text, outside code fences: [line index, level, title]. */
function headings(all: string[]): [number, number, string][] {
  const out: [number, number, string][] = []
  let fence: string | null = null
  for (let i = 0; i < all.length; i++) {
    const line = all[i]!.replace(/\n$/, '')
    const opener = FENCE.exec(line)
    if (fence) {
      if (opener && opener[1]![0] === fence[0] && opener[1]!.length >= fence.length && line.trim() === opener[1]) fence = null
      continue
    }
    if (opener) {
      fence = opener[1]!
      continue
    }
    const found = HEADING.exec(line)
    if (found) out.push([i, found[1]!.length, (found[2] ?? '').trim()])
  }
  return out
}

/** Whether a text has a heading outside code fences, and the shallowest level it has. */
export function shallowest(text: string): number | null {
  const found = headings(lines(text))
  return found.length ? Math.min(...found.map(([, level]) => level)) : null
}

export function parseDoc(body: string): Section[] {
  const all = lines(body)
  const marks = headings(all)
  const sections: Section[] = []
  const firstLine = marks.length ? marks[0]![0] : all.length
  sections.push({ key: '', title: '', level: 0, head: '', own: all.slice(0, firstLine).join(''), parent: null })
  const stack: { level: number; key: string }[] = []
  const seen = new Map<string, number>()
  for (let m = 0; m < marks.length; m++) {
    const [line, level, title] = marks[m]!
    const end = m + 1 < marks.length ? marks[m + 1]![0] : all.length
    while (stack.length && stack.at(-1)!.level >= level) stack.pop()
    const parent = stack.at(-1)?.key ?? null
    let key = (parent ? parent + '/' : '') + slug(title)
    const count = (seen.get(key) ?? 0) + 1
    seen.set(key, count)
    if (count > 1) key += '-' + count
    stack.push({ level, key })
    sections.push({ key, title, level, head: all[line]!, own: all.slice(line + 1, end).join(''), parent })
  }
  return sections
}

/** The index past a section's subtree: the next section at its level or above. */
export function subtreeEnd(sections: Section[], index: number): number {
  const level = sections[index]!.level
  if (level === 0) return index + 1
  let end = index + 1
  while (end < sections.length && sections[end]!.level > level) end++
  return end
}

const childrenOf = (metas: { key: string; level: number }[]) => {
  const out = new Map<string, string[]>()
  const stack: { key: string; level: number }[] = []
  for (const meta of metas) {
    if (meta.level === 0) continue
    while (stack.length && stack.at(-1)!.level >= meta.level) stack.pop()
    const parent = stack.at(-1)?.key ?? ''
    if (!out.has(parent)) out.set(parent, [])
    out.get(parent)!.push(meta.key)
    stack.push(meta)
  }
  return out
}

/** The new body's metas: a section keeps its changed revision while its own text is the same, and
 * its subtree revision while nothing in or under it changed and its children are the same ones. */
export function track(previous: Meta[] | null, next: Section[], seq: number): Meta[] {
  const old = new Map((previous ?? []).map((meta) => [meta.key, meta]))
  const metas: Meta[] = next.map((section) => {
    const hash = hashOf(raw(section))
    const before = old.get(section.key)
    const changed = before && before.hash === hash ? before.changed : seq
    return { key: section.key, title: section.title, level: section.level, hash, changed, subtree: changed }
  })
  const oldChildren = childrenOf(previous ?? [])
  const newChildren = childrenOf(metas)
  for (let i = metas.length - 1; i >= 0; i--) {
    const meta = metas[i]!
    if (meta.level === 0) continue
    const end = subtreeEnd(next, i)
    let subtree = meta.changed
    for (let j = i + 1; j < end; j++) subtree = Math.max(subtree, metas[j]!.subtree)
    const was = (oldChildren.get(meta.key) ?? []).join('\u0000')
    const now = (newChildren.get(meta.key) ?? []).join('\u0000')
    const before = old.get(meta.key)
    if (was !== now || !before) subtree = seq
    else subtree = Math.max(subtree, Math.min(before.subtree, seq))
    meta.subtree = Math.max(subtree, meta.changed)
  }
  return metas
}

// -- edits ------------------------------------------------------------------------------------

export type SectionEdit =
  | { section: string; text?: string; title?: string; subtree?: boolean }
  | { after: string; text: string }
  | { remove: string }

export class EditError extends Error {
  readonly code: string
  readonly status: number
  readonly section: string | undefined
  constructor(status: number, code: string, message: string, section?: string) {
    super(message)
    this.status = status
    this.code = code
    this.section = section
  }
}

const ended = (text: string) => (text === '' || text.endsWith('\n') ? text : text + '\n')
const headingLine = (level: number, title: string) => '#'.repeat(level) + ' ' + title.trim() + '\n'

/** Applies one edit to a body's sections, by key as they are now: the sections after it. */
export function applyEdit(sections: Section[], edit: SectionEdit): Section[] {
  const find = (key: string) => {
    const index = sections.findIndex((section) => section.key === key)
    if (index < 0) throw new EditError(404, 'section_not_found', 'no section ' + JSON.stringify(key) + ' in this doc', key)
    return index
  }
  const reparse = (pieces: string[]) => parseDoc(pieces.join(''))
  if ('remove' in edit) {
    const index = find(edit.remove)
    if (index === 0) return reparse(['', ...sections.slice(1).map(raw)])
    const end = subtreeEnd(sections, index)
    return reparse([...sections.slice(0, index), ...sections.slice(end)].map(raw))
  }
  if ('after' in edit) {
    const index = find(edit.after)
    const level = shallowest(edit.text)
    if (level === null || !/^ {0,3}#{1,6}(?:[ \t]|$)/.test(edit.text)) throw new EditError(400, 'invalid_edit', 'an inserted section starts with its heading, like "## Rollback"', edit.after)
    const end = subtreeEnd(sections, index)
    const pieces = sections.map(raw)
    if (end > 0) pieces[end - 1] = ended(pieces[end - 1]!)
    pieces.splice(end, 0, ended(edit.text))
    return reparse(pieces)
  }
  const index = find(edit.section)
  const section = sections[index]!
  if (edit.text === undefined && edit.title === undefined) throw new EditError(400, 'invalid_edit', 'an edit to ' + JSON.stringify(edit.section) + ' says nothing to change: give text, or a title', edit.section)
  if (edit.title !== undefined && index === 0) throw new EditError(400, 'invalid_edit', 'the text before the first heading has no title', edit.section)
  if (edit.title !== undefined && (edit.title.trim() === '' || /\n/.test(edit.title))) throw new EditError(400, 'invalid_edit', 'a title is one line of text', edit.section)
  const head = edit.title !== undefined ? headingLine(section.level, edit.title) : section.head
  const pieces = sections.map(raw)
  if (edit.subtree) {
    const text = edit.text ?? sections.slice(index + 1, subtreeEnd(sections, index)).reduce((all, child) => all + raw(child), section.own)
    const level = shallowest(text)
    if (level !== null && level <= section.level) throw new EditError(400, 'invalid_edit', "a section's new text may hold only deeper headings than its own (H" + (section.level + 1) + ' and below)', edit.section)
    const end = subtreeEnd(sections, index)
    const replaced = head + (end < sections.length ? ended(text) : text)
    pieces.splice(index, end - index, replaced)
    return reparse(pieces)
  }
  const own = edit.text ?? section.own
  if (edit.text !== undefined && shallowest(edit.text) !== null) throw new EditError(400, 'invalid_edit', 'a section edit replaces its own text, which holds no headings: to add or change subsections, edit with subtree: true or insert with after', edit.section)
  pieces[index] = head + (index + 1 < sections.length ? ended(own) : own)
  return reparse(pieces)
}

// -- the log's patch: an edit as the sections it changed --------------------------------------

export type Change = { section: string; op: 'edited' | 'inserted' | 'removed'; text?: string }
/** The new body's layout: a key reuses the previous version's section, a number is changes[n]. */
export type Patch = { changes: Change[]; layout: (string | number)[] }

export function diff(before: Section[], after: Section[]): Patch {
  const old = new Map(before.map((section) => [section.key, raw(section)]))
  const keys = new Set(after.map((section) => section.key))
  const changes: Change[] = []
  const layout: (string | number)[] = []
  for (const section of after) {
    const text = raw(section)
    const was = old.get(section.key)
    if (was === text) layout.push(section.key)
    else {
      layout.push(changes.length)
      changes.push({ section: section.key, op: was === undefined ? 'inserted' : 'edited', text })
    }
  }
  for (const section of before) if (!keys.has(section.key)) changes.push({ section: section.key, op: 'removed' })
  return { changes, layout }
}

export function replay(body: string, patch: Patch): string {
  const old = new Map(parseDoc(body).map((section) => [section.key, raw(section)]))
  return patch.layout.map((entry) => (typeof entry === 'number' ? patch.changes[entry]!.text! : old.get(entry) ?? '')).join('')
}

// -- the three-way merge, by section ------------------------------------------------------------

export type Merged = { body: string } | { conflicts: string[] }

export function merge(base: string, mine: string, theirs: string): Merged {
  const b = new Map(parseDoc(base).map((section) => [section.key, raw(section)]))
  const m = parseDoc(mine)
  const t = parseDoc(theirs)
  const mMap = new Map(m.map((section) => [section.key, raw(section)]))
  const tMap = new Map(t.map((section) => [section.key, raw(section)]))
  const conflicts: string[] = []
  const pick = (key: string): string | null => {
    const bb = b.get(key)
    const mm = mMap.get(key)
    const tt = tMap.get(key)
    if (mm === tt) return mm ?? null
    if (mm === bb) return tt ?? null
    if (tt === bb) return mm ?? null
    conflicts.push(key)
    return mm ?? tt ?? null
  }
  const order: string[] = m.map((section) => section.key)
  // Sections only theirs has (added there), after the one before them in theirs.
  for (let i = 0; i < t.length; i++) {
    const key = t[i]!.key
    if (order.includes(key) || b.has(key)) continue
    const prior = i > 0 ? t[i - 1]!.key : null
    const at = prior === null ? 0 : order.indexOf(prior) + 1
    order.splice(at > 0 ? at : order.length, 0, key)
  }
  // Sections removed on one side stay removed unless the other side changed them.
  for (const key of b.keys()) {
    if (order.includes(key)) continue
    if (tMap.has(key) && tMap.get(key) !== b.get(key)) conflicts.push(key)
  }
  const pieces: string[] = []
  for (const key of order) {
    const text = pick(key)
    if (text !== null) pieces.push(text)
  }
  if (conflicts.length) return { conflicts: [...new Set(conflicts)] }
  for (let i = 0; i < pieces.length - 1; i++) pieces[i] = ended(pieces[i]!)
  return { body: pieces.join('') }
}

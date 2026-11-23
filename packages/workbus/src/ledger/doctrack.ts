// A doc's section revisions (docs.ts): which sections an edit changed, by a hash of each section's
// text. Apart from doctext.ts because it needs node:crypto, and doctext.ts runs in a browser too.
import { createHash } from 'node:crypto'
import { raw, subtreeEnd, type Meta, type Section } from './doctext.ts'

export const hashOf = (text: string) => createHash('sha256').update(text).digest('base64url').slice(0, 16)

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

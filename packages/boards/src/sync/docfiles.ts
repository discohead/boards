// A platform's copy of a board doc (ledger/docs.ts), imported: what a provider that keeps docs in
// step (GitHub's Markdown files, say) calls when the platform's copy changed. The change merges
// into the board's doc by section against what the platform's copy was before, so what was written
// on the board meanwhile stays; when both changed the same sections, the board keeps its version and
// a task in the doc's channel says where the platform's is.
import type { Call } from './provider.ts'

export type DocFile = {
  /** The doc's channel and slug: its path on the board is channel/slug. */
  channel: string
  slug: string
  /** The platform's copy before this change (null when it's new there), and after. */
  before: string | null
  after: string
  /** Where the platform's copy is, for people: a URL, said in the task when the merge conflicts. */
  link: string
  /** What the platform calls it (docs/deploy.md), for the task's words. */
  name: string
  /** A mirror: the doc is the platform's copy, made and changed only by this sync (people edit it there). */
  mirror?: boolean
}

/** The doc's answer (created or edited), or the task made when both sides changed the same sections. */
export async function importDocFile(call: Call, file: DocFile): Promise<{ doc?: unknown; task?: unknown }> {
  const path = file.channel + '/' + file.slug
  const found = await call('docAt', { path, depth: 1 }).catch((error: { code?: string }) => {
    if (error?.code === 'doc_not_found') return null
    throw error
  })
  if (!found) return { doc: await call('createDoc', { channel: file.channel, slug: file.slug, body: file.after, ...(file.mirror ? { mirror: true } : {}) }) }
  // A mirror is what the platform says, whole.
  if (file.mirror) return { doc: await call('editDoc', { id: found.doc.id, revision: found.doc.revision, body: file.after }) }
  // Nothing new: the platform's copy says what the doc says (the courier's own write, come back).
  if (file.before !== null && file.before === file.after) return { doc: found }
  try {
    return { doc: await call('editDoc', { id: found.doc.id, base: file.before ?? '', body: file.after, merge: true }) }
  } catch (error) {
    const failure = error as { code?: string; data?: { sections?: string[] } }
    if (failure.code !== 'merge_conflict') throw error
    const sections = (failure.data?.sections ?? []).map((section) => '\u0060' + (section || '(the top)') + '\u0060').join(', ')
    const task = await call('createTask', {
      channel: file.channel,
      text: file.name + ' and [[' + path + ']] both changed ' + (sections || 'the same sections') + '. The board kept its version; the other is at ' + file.link + '. Fold them together in the doc, then complete this task.',
    })
    return { task }
  }
}

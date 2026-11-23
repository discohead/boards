// A doc's body as the board splits it (design/docs.md §2.4): the same parser the Ledger runs, so
// the keys the view shows, edits, and anchors comments to are the board's own.
import { applyEdit, bodyOf, parseDoc, type Section } from 'workbus/ledger/doctext.ts'

export type { Section }
export { parseDoc }

/** The body with one section's own text replaced (its heading and subsections stay). */
export function withSection(body: string, key: string, text: string): string {
  return bodyOf(applyEdit(parseDoc(body), { section: key, text }))
}

/** A section's own text, without its heading: what a section edit replaces. */
export function ownText(body: string, key: string): string | null {
  return parseDoc(body).find((section) => section.key === key)?.own ?? null
}

// The thread pane's body face, for a doc: the doc view, by section (src/docs/DocView.tsx). Its
// doc-wide comments are the pane's conversation.
import { DocView } from '@/docs/DocView'
import type { Message } from '@/data'

export function Body({ root }: { root: Message }) {
  return (
    <section aria-label="Body" data-testid="body" className="border-b">
      <DocView id={root.doc!.id} inPane />
    </section>
  )
}

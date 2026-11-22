// The thread pane's body face, for a doc: its body, loaded when the thread opens. A stub for the doc
// view's owner (it will render Markdown and edit by section).
import { useEffect } from 'react'
import { useLiveQuery } from '@tanstack/react-db'
import { eq } from '@tanstack/db'
import { useBus, type Message } from '@/data'

export function Body({ root }: { root: Message }) {
  const bus = useBus()
  const doc = root.doc!
  useEffect(() => void bus.openDoc(doc.id), [bus, doc.id])
  const { data } = useLiveQuery({ query: (q) => q.from({ body: bus.bodies }).where(({ body }) => eq(body.id, doc.id)) })
  return (
    <section aria-label="Body" data-testid="body" className="border-b p-4 text-sm">
      <h2 className="font-medium">{doc.title}</h2>
      <pre className="mt-2 whitespace-pre-wrap font-sans">{data[0]?.body ?? '…'}</pre>
    </section>
  )
}

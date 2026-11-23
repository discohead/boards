// The thread pane's Request panel: for a thread whose messages carry org.request (made for a request)
// or that started one (seats' work stamped with its ID), what the request came to and its latest
// steps, and a link to the whole of it at /requests/<id>.
import { useLiveQuery } from '@tanstack/react-db'
import { eq } from '@tanstack/db'
import { useBus, type Message } from '@/data'
import { REQUEST_LABEL } from '@/requests/model'
import { RequestFacts, RequestLink, RequestTimeline } from '@/requests/timeline'
import { useRequest } from '@/requests/use-request'

/** The request this thread belongs to: a label on its root or a reply, or the root itself when the seats' work names it. */
export function useThreadRequest(root: Message | null): string | null {
  const bus = useBus()
  const { data: messages } = useLiveQuery({ query: (q) => q.from({ message: bus.messages }).where(({ message }) => eq(message.thread, root?.thread ?? '')) })
  if (!root) return null
  const labeled = [root, ...messages].map((one) => one.labels?.[REQUEST_LABEL]).find(Boolean)
  return labeled ?? null
}

export function RequestPanel({ root }: { root: Message }) {
  const labeled = useThreadRequest(root)
  // A person's root with no label may itself be a request: the seats' work names its ID.
  const candidate = labeled ?? (root.by.actor.includes('+') || root.by.actor.startsWith('worker:') ? null : root.id)
  const { record } = useRequest(candidate)
  if (!candidate || !record) return null
  if (!labeled && record.threads.length === 0) return null
  return (
    <section aria-label="Request" data-testid="request-panel" data-request={candidate} className="mx-6 mb-3 rounded-md border border-line bg-sidebar px-4 py-3">
      <div className="mb-2 flex items-center justify-between">
        <h3 className="font-mono text-mono-label tracking-[0.07em] text-muted-foreground uppercase">What happened with this request</h3>
        <RequestLink id={candidate}>Open request #{candidate}</RequestLink>
      </div>
      <RequestFacts record={record} />
      <div className="mt-2">
        <RequestTimeline record={record} limit={6} />
      </div>
    </section>
  )
}

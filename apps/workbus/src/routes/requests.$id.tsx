// A request (design/workbus.md §6, the principal in the loop): everything one message of the
// principal's caused, across channels: the plan, the handoff, tasks and who did them, proposals and
// hires, docs, approvals and holds, and what the runs cost, each with its state and a link, in time
// order. Built on the org.request label the seats stamp on what they make.
import { createFileRoute } from '@tanstack/react-router'
import { ListPane } from '@/shell/list-pane'
import { useOpenThread } from '@/shell/open-thread'
import { named, summaryOf } from '@/data/text'
import { useActorNames } from '@/task/actors'
import { RequestFacts, RequestTimeline } from '@/requests/timeline'
import { useRequest } from '@/requests/use-request'

export const Route = createFileRoute('/requests/$id')({ component: RequestPage })

function RequestPage() {
  const { id } = Route.useParams()
  const { record, error } = useRequest(id)
  const name = useActorNames()
  const { open } = useOpenThread()
  const title = record?.root ? summaryOf(record.root.text, named(name)) : 'Request #' + id
  return (
    <ListPane title={'Request #' + id} label={'Request ' + id} foot={false}>
      <div data-testid="request" data-request={id} className="mx-auto flex max-w-[860px] flex-col gap-4 px-6 py-6">
        {!record ? (
          <p className="text-sm text-muted-foreground">{error ? "Couldn't read it: " + error : 'Reading what it caused…'}</p>
        ) : (
          <>
            <div>
              <button type="button" className="text-left text-title-md text-text hover:underline" onClick={() => open(record.root?.re ?? id)}>
                {title}
              </button>
              {record.root ? (
                <div className="mt-1 font-mono text-mono-ui text-muted-foreground">
                  @{name(record.root.by.actor)} in {record.root.channel}
                </div>
              ) : null}
            </div>
            <RequestFacts record={record} />
            {record.events.length === 0 ? <p data-testid="request-empty" className="text-[13px] text-muted-foreground">Nothing carries this request yet: what seats make for it is stamped org.request={id}.</p> : null}
            <RequestTimeline record={record} />
          </>
        )}
      </div>
    </ListPane>
  )
}

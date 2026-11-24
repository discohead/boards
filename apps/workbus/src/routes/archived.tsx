// Archived channels (issue #15): what an owner archived, out of the sidebar, each with what archived
// it (itself, or a subtree) and Unarchive. Opening one reads it, read-only.
import { createFileRoute, Link } from '@tanstack/react-router'
import { useLiveQuery } from '@tanstack/react-db'
import { Archive, Hash, MessageSquare } from 'lucide-react'
import { useBus, type Channel } from '@/data'
import { ListPane } from '@/shell/list-pane'
import { Button, toast } from '@/components/system'

export const Route = createFileRoute('/archived')({ component: Archived })

function Archived() {
  const bus = useBus()
  const { data: channels } = useLiveQuery({ query: (q) => q.from({ channel: bus.channels }).orderBy(({ channel }) => channel.path, 'asc') })
  const archived = channels.filter((channel) => channel.archived)
  const unarchive = (channel: Channel) =>
    void bus.actions.unarchiveChannel(channel.archived!.pattern).then(
      () => toast({ children: 'Unarchived ' + channel.archived!.pattern + '.' }),
      (error: Error) => toast({ children: 'Not unarchived: ' + error.message, tone: 'danger' }),
    )
  return (
    <ListPane title="Archived" foot={false}>
      {archived.length === 0 ? (
        <p className="px-4 py-6 text-sm text-muted-foreground">Nothing is archived. Archive a channel from its menu.</p>
      ) : (
        <ul data-testid="archived-channels">
          {archived.map((channel) => {
            const live = channel.live ?? { messages: channel.messages, threads: channel.threads }
            return (
              <li key={channel.path} data-channel={channel.path} className="flex items-center gap-3 border-b border-line px-4 py-2.5">
                {channel.path.startsWith('dm/') ? <MessageSquare size={16} strokeWidth={1.5} aria-hidden /> : <Hash size={16} strokeWidth={1.5} aria-hidden />}
                <Link to="/c/$" params={{ _splat: channel.path }} className="font-medium text-text hover:underline">
                  {channel.path}
                </Link>
                <span className="font-mono text-mono-label text-muted-foreground">
                  {live.threads} {live.threads === 1 ? 'thread' : 'threads'}
                  {channel.archived!.pattern !== channel.path ? ' · with ' + channel.archived!.pattern : ''}
                  {' · ' + new Date(channel.archived!.at).toLocaleDateString()}
                </span>
                <span className="ml-auto">
                  <Button size="sm" icon={Archive} onClick={() => unarchive(channel)}>
                    Unarchive
                  </Button>
                </span>
              </li>
            )
          })}
        </ul>
      )}
    </ListPane>
  )
}

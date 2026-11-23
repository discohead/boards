// A channel: its threads, newest at the bottom, live, and a box to start one (src/channel/). Opening
// a thread sets ?thread=<id>.
import { createFileRoute } from '@tanstack/react-router'
import { ChannelView } from '@/channel/channel-view'

export const Route = createFileRoute('/c/$')({ component: Channel })

function Channel() {
  const channel = Route.useParams()._splat ?? ''
  return <ChannelView channel={channel} />
}

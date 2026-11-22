// The read state routes (ledger/reads.ts): every unread count at once, and marking read.
import { z } from 'zod'
import { ChannelPath, Ref } from './fields.ts'
import { route } from './routes.ts'

const Position = z.string().regex(/^(0|[1-9]\d{0,15})$/, 'upto is a message ID or a feed cursor, like "812"')
const Scope = z.string().min(1).max(501).refine((value) => ChannelPath.safeParse(value.endsWith('/') ? value.slice(0, -1) : value).success, 'a channel, or a subtree like eng/')

route({ name: 'unread', method: 'GET', path: '/unread', query: z.strictObject({ channel: Scope.optional() }) })
route({
  name: 'markRead',
  method: 'POST',
  path: '/read',
  body: z
    .strictObject({ channel: ChannelPath.optional(), thread: Ref.optional(), upto: Position.optional() })
    .refine((body) => (body.channel === undefined) !== (body.thread === undefined), { message: 'mark one thing read: a \u0060channel\u0060 or a \u0060thread\u0060' }),
})

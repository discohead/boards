// The core routes: who you are, channels, messages, threads, and the feed.
import { z } from 'zod'
import { AttachmentId, ChannelPath, ClientId, Emoji, ExternalTarget, Filters, LabelKey, LabelValue, NewLabels, QueryBool, QueryInt, Ref, SentText } from './fields.ts'
import { route } from './routes.ts'

export const ChannelsQuery = z.strictObject({ prefix: z.string().min(1).max(501).optional(), after: z.string().min(1).max(1024).optional(), limit: QueryInt(1, 500).optional() })

const SyncRequest = z.union([z.string().min(3).max(300), z.object({ target: ExternalTarget, kind: z.enum(['channel', 'thread']) })])

export const PostBody = z
  .object({
    channel: ChannelPath.optional(),
    re: Ref.optional(),
    text: z.string().default(''),
    labels: NewLabels.optional(),
    noSync: z.boolean().optional(),
    sync: z.array(SyncRequest).max(10).optional(),
    id: ClientId.optional(),
    attachments: z.array(AttachmentId).optional(),
    after: Ref.optional(),
  })
  .refine((body) => body.text.trim().length > 0 || (body.attachments?.length ?? 0) > 0, { path: ['text'], message: 'message text is empty' })
  .refine((body) => (body.channel === undefined) !== (body.re === undefined), { message: 'a post needs \u0060channel\u0060; a reply needs \u0060re\u0060' })
  .refine((body) => !(body.noSync && body.sync?.length), { message: '\u0060noSync\u0060 and \u0060sync\u0060 contradict each other' })
  .refine((body) => body.after === undefined || body.re !== undefined, { path: ['after'], message: "\u0060after\u0060 is for replies: it names the newest message in \u0060re\u0060's thread" })

route({ name: 'discovery', method: 'GET', path: '/', open: true, gateway: true })
route({ name: 'openapi', method: 'GET', path: '/openapi.json', open: true, gateway: true })
route({ name: 'avatar', method: 'GET', path: '/avatars/:name', open: true, gateway: true })
route({ name: 'me', method: 'GET', path: '/me', query: ChannelsQuery })
route({ name: 'actors', method: 'GET', path: '/actors' })
route({ name: 'channels', method: 'GET', path: '/channels', query: ChannelsQuery })
route({ name: 'createChannel', method: 'POST', path: '/channels', body: z.strictObject({ path: ChannelPath }), status: 'created' })
route({ name: 'channelMessages', method: 'GET', path: '/messages', query: z.strictObject({ channel: ChannelPath, after: Ref.optional(), limit: QueryInt(1, 500).optional() }) })
route({ name: 'message', method: 'GET', path: '/messages/:id', query: z.strictObject({ after: Ref.optional(), limit: QueryInt(1, 500).optional() }) })
route({
  name: 'threads',
  method: 'GET',
  path: '/threads',
  query: Filters.extend({ after: Ref.optional(), before: z.string().min(1).max(1024).optional(), limit: QueryInt(1, 500).optional() }).refine((query) => !(query.before !== undefined && query.after !== undefined), {
    path: ['before'],
    message: "\u0060before\u0060 pages back from a page's \u0060older\u0060, and \u0060after\u0060 reads forward: pass one",
  }),
})
route({ name: 'post', method: 'POST', path: '/messages', body: PostBody, status: 201 })
route({ name: 'posted', method: 'GET', path: '/posts/:id' })
route({ name: 'edit', method: 'POST', path: '/messages/:id/edit', body: z.object({ text: SentText, revision: z.number().int().min(1).optional() }) })
route({ name: 'delete', method: 'POST', path: '/messages/:id/delete', body: z.object({ revision: z.number().int().min(1).optional() }), optionalBody: true })
route({ name: 'react', method: 'POST', path: '/messages/:id/reactions', body: z.object({ emoji: Emoji, remove: z.boolean().optional() }) })
route({
  name: 'label',
  method: 'POST',
  path: '/messages/:id/labels',
  body: z
    .object({ set: NewLabels.optional(), unset: z.array(LabelKey).optional(), if: z.record(LabelKey, LabelValue.nullable()).refine((value) => Object.keys(value).length <= 16, 'at most 16 labels').optional() })
    .refine((body) => body.set !== undefined || body.unset !== undefined, { message: 'nothing to change: pass \u0060set\u0060 or \u0060unset\u0060' }),
})
route({ name: 'typing', method: 'POST', path: '/messages/:id/typing', body: z.object({ status: z.string().trim().min(1).max(50).optional() }), optionalBody: true })
route({
  name: 'events',
  method: 'GET',
  path: '/events',
  query: Filters.extend({ after: Ref.optional(), wait: z.coerce.number().min(0).max(300).optional(), all: QueryBool.optional(), last: QueryInt(1, 100).optional() }).refine((query) => query.last === undefined || (query.after === undefined && query.wait === undefined), {
    path: ['last'],
    message: '\u0060last\u0060 reads the newest events at once: it takes no \u0060after\u0060 or \u0060wait\u0060',
  }),
})

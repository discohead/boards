// The core routes: who you are, channels, messages, threads, and the feed.
import { z } from 'zod'
import { AttachmentId, ChannelPath, ClientId, Emoji, ExternalTarget, Filters, LabelKey, LabelValue, NewLabels, QueryBool, QueryInt, Ref, SentText } from './fields.ts'
import { GATEWAY, route } from './routes.ts'

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
    // A comment on a doc's section, by its key: the reply carries board.doc.section.
    section: z.string().max(1024).optional(),
  })
  .refine((body) => body.section === undefined || body.re !== undefined, { path: ['section'], message: '\u0060section\u0060 is for a comment on a doc: a reply, with \u0060re\u0060' })
  .refine((body) => body.text.trim().length > 0 || (body.attachments?.length ?? 0) > 0, { path: ['text'], message: 'message text is empty' })
  .refine((body) => (body.channel === undefined) !== (body.re === undefined), { message: 'a post needs \u0060channel\u0060; a reply needs \u0060re\u0060' })
  .refine((body) => !(body.noSync && body.sync?.length), { message: '\u0060noSync\u0060 and \u0060sync\u0060 contradict each other' })
  .refine((body) => body.after === undefined || body.re !== undefined, { path: ['after'], message: "\u0060after\u0060 is for replies: it names the newest message in \u0060re\u0060's thread" })

route({ name: 'discovery', method: 'GET', path: '/', open: true, gateway: true })
route({ name: 'openapi', method: 'GET', path: '/openapi.json', open: true, gateway: true })
route({ name: 'avatar', method: 'GET', path: '/avatars/:name', open: true, gateway: true })

// A mark for an agent or a person with no picture of their own: its initial on a color from its name. No token, cached a day.
const AVATAR_NAME = /^[a-z0-9][a-z0-9-]{0,31}$/
GATEWAY.avatar = async (_request, _env, { params }) => {
  const name = params.name ?? ''
  if (!AVATAR_NAME.test(name)) return Response.json({ error: { code: 'not_found', message: 'no avatar: ' + name.slice(0, 64) } }, { status: 404 })
  let hash = 2166136261
  for (const char of name) hash = Math.imul(hash ^ char.charCodeAt(0), 16777619) >>> 0
  const hue = hash % 360
  const svg = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64" role="img" aria-label="' + name + '">' +
    '<rect width="64" height="64" rx="14" fill="hsl(' + hue + ' 62% 42%)"/>' +
    '<text x="32" y="43" text-anchor="middle" font-family="system-ui, sans-serif" font-size="30" font-weight="700" fill="#fff">' + name[0]!.toUpperCase() + '</text></svg>'
  return new Response(svg, { headers: { 'content-type': 'image/svg+xml', 'cache-control': 'public, max-age=86400' } })
}
route({ name: 'me', method: 'GET', path: '/me', query: ChannelsQuery })
/** A display name: trimmed, 1 to 64 characters, no control characters. */
export const DisplayName = z
  .string()
  .transform((value) => value.trim())
  .refine((value) => value.length >= 1 && [...value].length <= 64, 'a display name is 1 to 64 characters')
  .refine((value) => !/\p{Cc}/u.test(value), 'a display name has no control characters')
route({ name: 'setName', method: 'PATCH', path: '/me', body: z.strictObject({ name: DisplayName }) })
route({ name: 'actors', method: 'GET', path: '/actors', query: z.strictObject({ hidden: QueryBool.optional() }) })
route({ name: 'hideActor', method: 'POST', path: '/actors/hide', body: z.strictObject({ actor: z.string().min(1).max(300), hidden: z.boolean().optional() }) })
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

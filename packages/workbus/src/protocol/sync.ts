// Sync's records and the sync inbox: imports, receipts, lookups, where a thread syncs, links, and
// the platform events a sync pulls back one platform thread at a time.
import { z } from 'zod'
import { AttachmentId, ChannelPath, ClientId, Emoji, ExternalTarget, LabelKey, LabelValue, NewLabels, QueryInt, Ref, SentText } from './fields.ts'
import { route } from './routes.ts'

const SyncKey = z.string().min(1).max(64)
const PlatformUser = z.object({ id: z.string().min(1).max(300), handle: z.string().min(1).max(256), name: z.string().min(1).max(256), avatar: z.string().max(4000).nullable(), isBot: z.boolean() })
const Origin = z.object({
  channel: ExternalTarget.optional(),
  thread: ExternalTarget,
  subthread: ExternalTarget.nullable().default(null),
  message: z.string().min(1).max(300),
  context: z.string().max(300).nullable().default(null),
})
const ImportOrigin = z.object({ thread: ExternalTarget, message: z.string().min(1).max(300).optional() })
const ImportSource = z.object({ key: SyncKey, channel: ExternalTarget, thread: ExternalTarget })
const LinkSnapshot = z.object({
  author: z.string().min(1).max(256),
  text: z.string().max(10_000),
  createdAt: z.string().max(64).nullable(),
  files: z.array(z.object({ name: z.string().min(1).max(1000), url: z.string().max(4000).nullable() })).max(20),
})
const ImportLink = z.object({ url: z.string().min(1).max(4000), message: Ref.nullable().default(null), snapshot: LinkSnapshot.nullable().default(null), unavailable: z.string().max(300).nullable().default(null) })
const Mentioned = z.array(PlatformUser).max(50).optional()
const MessageText = SentText.pipe(z.string().max(10_000))
const From = SyncKey.nullable()
const Changed = { origin: ImportOrigin.optional(), message: Ref.optional() }

export const SyncImportBody = z.discriminatedUnion('op', [
  z.object({
    op: z.literal('post'),
    author: PlatformUser,
    from: From,
    origin: Origin.nullable().default(null),
    source: ImportSource.optional(),
    channel: ChannelPath.optional(),
    re: Ref.optional(),
    text: z.string().max(10_000).default(''),
    labels: NewLabels.optional(),
    noSync: z.boolean().optional(),
    attachments: z.array(AttachmentId).max(10).optional(),
    links: z.array(ImportLink).max(10).optional(),
    mentioned: Mentioned,
    id: ClientId.optional(),
    after: Ref.optional(),
  }),
  z.object({ op: z.literal('edit'), author: PlatformUser, from: From, ...Changed, text: MessageText, source: ImportSource.optional(), revision: z.number().int().min(1).optional(), mentioned: Mentioned }),
  z.object({ op: z.literal('delete'), author: PlatformUser, from: From, ...Changed, revision: z.number().int().min(1).optional() }),
  z.object({ op: z.literal('react'), author: PlatformUser, from: From, ...Changed, emoji: Emoji, remove: z.boolean().default(false) }),
  z.object({ op: z.literal('labels'), author: PlatformUser, from: From, ...Changed, set: NewLabels.optional(), unset: z.array(LabelKey).optional(), if: z.record(LabelKey, LabelValue.nullable()).optional() }),
  z.object({ op: z.literal('links'), author: PlatformUser, from: From, ...Changed, links: z.array(ImportLink).max(10) }),
])

const PlatformFiles = z.array(z.string().min(1).max(300)).max(10).nullable()

export const SyncReceiptBody = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('message'), message: Ref, target: ExternalTarget, external: z.object({ thread: ExternalTarget, message: z.string().min(1).max(300) }), files: PlatformFiles.optional() }),
  z.object({ kind: z.literal('files'), message: Ref, target: ExternalTarget, files: PlatformFiles }),
  z.object({ kind: z.literal('failed'), message: Ref, target: ExternalTarget, error: z.string().min(1).max(500) }),
  z.object({ kind: z.literal('thread'), message: Ref, target: ExternalTarget, targetKind: z.enum(['channel', 'thread']), cause: z.enum(['config', 'request']) }),
])

route({ name: 'syncImport', method: 'POST', path: '/sync/imports', body: SyncImportBody })
route({ name: 'syncReceipt', method: 'POST', path: '/sync/receipts', body: SyncReceiptBody })
route({ name: 'syncThread', method: 'GET', path: '/sync/threads/:thread' })
route({ name: 'syncFind', method: 'GET', path: '/sync/find', query: z.object({ post: z.string().min(1).max(200).optional(), thread: ExternalTarget.optional(), message: z.string().min(1).max(300).optional() }) })
route({ name: 'syncCopies', method: 'GET', path: '/sync/copies', query: z.object({ message: z.union([Ref, z.array(Ref).min(1).max(100)]) }) })
route({ name: 'synced', method: 'GET', path: '/messages/:id/sync' })
route({ name: 'sync', method: 'POST', path: '/messages/:id/sync', body: z.object({ target: z.string().min(3).max(300) }) })
route({ name: 'linked', method: 'GET', path: '/links', query: z.object({ url: z.string().max(4000).url() }) })
// A platform's webhook for one of the board's own syncs: verified by its provider, kept by its Inbox.
route({ name: 'webhook', method: 'POST', path: '/webhooks/:key', open: true, gateway: true })

// -- the inbox ------------------------------------------------------------------------------------

const Location = { channel: ExternalTarget, thread: ExternalTarget, subthread: ExternalTarget.nullable() }
const ExternalAuthor = z.object({ id: z.string().min(1), handle: z.string().min(1), name: z.string().min(1), avatar: z.string().nullable(), isBot: z.boolean() })
const ExternalFile = z.object({
  type: z.enum(['image', 'file', 'video', 'audio']),
  name: z.string().max(1000).optional(),
  mimeType: z.string().max(255).optional(),
  size: z.number().int().min(0).optional(),
  url: z.string().max(4000).optional(),
  fetchMetadata: z.record(z.string(), z.string().max(4000)).optional(),
})
const ExternalLink = z.object({ url: z.string().min(1).max(4000), thread: ExternalTarget, message: z.string().min(1).max(300), snapshot: LinkSnapshot.nullable() })

export const ExternalEvent = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('message'), ...Location, message: z.string(), isRoot: z.boolean(), text: z.string(), context: z.string().nullable(), author: ExternalAuthor, files: z.array(ExternalFile).max(20).optional(), links: z.array(ExternalLink).max(10).optional(), mentioned: z.array(ExternalAuthor).max(50).optional() }),
  z.object({ kind: z.literal('edited'), ...Location, message: z.string(), text: z.string(), author: ExternalAuthor, links: z.array(ExternalLink).max(10).optional(), linksOnly: z.boolean().optional(), mentioned: z.array(ExternalAuthor).max(50).optional() }),
  z.object({ kind: z.literal('deleted'), ...Location, message: z.string() }),
  z.object({ kind: z.literal('reaction'), ...Location, message: z.string(), emoji: z.string(), added: z.boolean(), author: ExternalAuthor }),
  z.object({
    kind: z.literal('lifecycle'),
    channel: ExternalTarget,
    thread: ExternalTarget,
    type: z.string(),
    title: z.string(),
    url: z.string().nullable(),
    body: z.string().nullable().optional(),
    labels: z.record(z.string(), z.string()),
    unset: z.array(z.string()),
    owns: z.array(z.string()).optional(),
    reply: z.string().nullable(),
    createRoot: z.boolean(),
    retitled: z.boolean().optional(),
    author: ExternalAuthor,
  }),
])

const InboxEventId = z.string().min(1).max(300, { error: (issue) => 'an inbox event ID is 300 characters at most, got ' + String((issue.input as string)?.length) })
const InboxItem = z
  .custom<Record<string, unknown>>((value) => value !== null && typeof value === 'object' && Object.hasOwn(value as object, 'raw'), { message: 'raw: an inbox event carries its raw platform payload, null when there is none' })
  .pipe(z.object({ id: InboxEventId, event: ExternalEvent, raw: z.unknown() }))

route({ name: 'inbox', method: 'GET', path: '/inbox/:key', query: z.object({ channel: z.string().min(1).max(300).optional(), limit: QueryInt(1, 500).optional() }) })
route({ name: 'inboxPush', method: 'POST', path: '/inbox/:key', body: z.object({ events: z.array(InboxItem).min(1).max(50) }) })
// One of the board's own syncs: put its failed events back in their lanes (all, or the IDs named). Needs manage everywhere.
route({ name: 'inboxReplay', method: 'POST', path: '/inbox/:key/replay', body: z.object({ ids: z.array(z.string().min(1).max(300)).max(100).optional() }), optionalBody: true })
route({ name: 'inboxNext', method: 'GET', path: '/inbox/:key/next', query: z.object({ limit: QueryInt(1, 50).optional() }) })
route({ name: 'inboxAck', method: 'POST', path: '/inbox/:key/:id/ack', body: z.object({ lease: z.string().min(1).max(64), error: z.string().min(1).max(500).optional() }) })
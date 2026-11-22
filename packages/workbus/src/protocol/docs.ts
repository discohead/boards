// The docs routes: a thread with a body, read and edited by section (ledger/docs.ts).
import { z } from 'zod'
import { ChannelPath, ClientId, NewLabels, QueryInt, Ref, storable } from './fields.ts'
import { route } from './routes.ts'

const Slug = z.string().regex(/^[a-z0-9][a-z0-9_-]{0,127}$/, "a doc's slug is lowercase letters, numbers, _, and -, up to 128, starting with a letter or number")
const Body = z.string().max(600_000).refine(storable, 'the body has a NUL character or a lone surrogate')
const Key = z.string().max(1024)
const Revision = z.string().regex(/^[1-9]\d{0,15}$/, 'a revision is a number, like "812", as a doc\'s view gives it')

const SectionEdit = z.union([
  z.strictObject({ section: Key, text: Body.optional(), title: z.string().min(1).max(512).optional(), subtree: z.boolean().optional() }),
  z.strictObject({ after: Key, text: Body }),
  z.strictObject({ remove: Key }),
])

export const CreateDocBody = z
  .strictObject({ channel: ChannelPath.optional(), re: Ref.optional(), slug: Slug.optional(), body: Body.optional(), from: Ref.optional(), labels: NewLabels.optional(), id: ClientId.optional(), mirror: z.boolean().optional() })
  .refine((body) => (body.channel === undefined) !== (body.re === undefined), { message: 'a new doc names its \u0060channel\u0060; a thread that becomes a doc names its root, \u0060re\u0060: pass one' })
  .refine((body) => body.re !== undefined || body.slug !== undefined, { path: ['slug'], message: 'a new doc names its \u0060slug\u0060' })
  .refine((body) => body.re !== undefined || (body.body === undefined) !== (body.from === undefined), { message: 'a doc starts from its body, or from another doc: pass one of \u0060body\u0060 and \u0060from\u0060' })
  .refine((body) => body.re === undefined || (body.body === undefined || body.from === undefined), { message: "a thread becomes a doc with its root's text, a new \u0060body\u0060, or another doc's (\u0060from\u0060): pass one at most" })
  .refine((body) => body.re === undefined || (body.id === undefined && body.mirror === undefined), { message: '\u0060id\u0060 and \u0060mirror\u0060 are for a new doc, not a thread that becomes one' })

export const EditDocBody = z
  .strictObject({
    revision: Revision.optional(),
    base: Body.optional(),
    edits: z.array(SectionEdit).min(1).max(100).optional(),
    body: Body.optional(),
    merge: z.boolean().optional(),
    propose: z.boolean().optional(),
    note: z.string().max(2000).optional(),
  })
  .refine((body) => (body.edits === undefined) !== (body.body === undefined), { message: 'an edit gives \u0060edits\u0060 (by section) or \u0060body\u0060 (the whole of it): one of them' })
  .refine((body) => body.merge === undefined || body.body !== undefined, { path: ['merge'], message: '\u0060merge\u0060 goes with a whole \u0060body\u0060' })
  .refine((body) => body.base === undefined || body.merge === true, { path: ['base'], message: '\u0060base\u0060 is what a merge started from: send it with merge: true' })
  .refine((body) => body.note === undefined || body.propose === true, { path: ['note'], message: '\u0060note\u0060 explains a proposal: send it with propose: true' })

const ReadQuery = { section: Key.optional(), revision: Revision.optional(), depth: QueryInt(1, 6).optional() }

route({ name: 'createDoc', method: 'POST', path: '/docs', body: CreateDocBody, status: 201 })
route({ name: 'docAt', method: 'GET', path: '/docs', query: z.strictObject({ path: z.string().min(3).max(2200), ...ReadQuery }) })
route({ name: 'doc', method: 'GET', path: '/docs/:id', query: z.strictObject(ReadQuery) })
route({ name: 'editDoc', method: 'POST', path: '/docs/:id/edit', body: EditDocBody })
route({ name: 'moveDoc', method: 'POST', path: '/docs/:id/move', body: z.strictObject({ channel: ChannelPath.optional(), slug: Slug.optional() }).refine((body) => body.channel !== undefined || body.slug !== undefined, { message: 'a move names a new \u0060channel\u0060, a new \u0060slug\u0060, or both' }) })
route({ name: 'docHistory', method: 'GET', path: '/docs/:id/history', query: z.strictObject({ after: Revision.optional(), limit: QueryInt(1, 500).optional() }) })
route({ name: 'docDiff', method: 'GET', path: '/docs/:id/diff', query: z.strictObject({ from: Revision, to: Revision.optional() }) })
route({ name: 'docBacklinks', method: 'GET', path: '/docs/:id/backlinks' })

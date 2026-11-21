// Notion, as a platform the board keeps docs in step with: each page it's given is a board doc, its
// title the doc's first heading and its content the rest, in Notion-flavored Markdown. A page is a
// mirror (one-way: the doc is what Notion says, and only Notion changes it) or two-way: a change in
// Notion merges into the doc by section against what Notion last held, and what's written on the
// board goes back as one exact replacement per changed section, so the blocks it didn't change (and
// their comments) stay as they are. Notion's webhooks say a page changed; the page is read then.
import { importDocFile } from './docfiles.ts'
import { parseDoc, raw } from '../ledger/doctext.ts'
import { SyncRefused, SyncRetry, type Call, type InboxEvent, type SyncProvider } from './provider.ts'
import { hmacHex, sameString, secretReader, type Secret } from './secrets.ts'

export type NotionPage = {
  /** The doc it is on the board: channel/slug. */
  channel: string
  slug: string
  /** Two-way: what's written on the board goes back to the page. Otherwise the doc mirrors the page. */
  twoWay?: boolean
}

export type NotionOptions = {
  /** The integration's token (an internal integration's secret): a Worker secret, or a Secrets Store binding. */
  token: Secret
  /** The webhook's verification token, which Notion signs deliveries with. Until it's set, only the verification request is answered. */
  webhookSecret?: Secret
  /** Each page (its ID, with or without dashes) and the doc it is. */
  pages: Record<string, NotionPage>
  /** Where Notion's API is: https://api.notion.com unless a test says otherwise. */
  apiBase?: string
}

export type NotionEvent = { kind: 'page'; page: string }

export const NOTION_VERSION = '2026-03-11'
/** The label on a two-way doc: the revision Notion last held, the base its next change merges against. */
export const SYNCED_LABEL = 'notion.synced'

/** A page ID as Notion's URLs and events write it, in one form: 32 hex digits, lowercase. */
export const pageId = (id: string) => id.replace(/-/g, '').toLowerCase()

/** Whether Notion signed this body with the verification token: X-Notion-Signature is sha256=hex(HMAC-SHA256(token, body)). */
export async function verifyNotion(body: string, signature: string, secret: string): Promise<boolean> {
  return sameString(signature, 'sha256=' + (await hmacHex(secret, body)))
}

/** A page as a doc: its title as the first heading, then its content. */
export function docText(title: string, markdown: string): string {
  const content = markdown.replace(/^\s+/, '').replace(/\s+$/, '')
  return '# ' + (title.trim() || 'Untitled') + '\n' + (content ? '\n' + content + '\n' : '')
}

/** A doc as a page: its title (the first heading, when the doc starts with one) and its content. */
export function pageText(body: string): { title: string | null; markdown: string } {
  const found = body.match(/^# (.*)\n/)
  if (!found) return { title: null, markdown: body.trim() }
  return { title: found[1]!.trim(), markdown: body.slice(found[0].length).trim() }
}

const count = (text: string, part: string) => {
  let n = 0
  for (let at = text.indexOf(part); at !== -1; at = text.indexOf(part, at + 1)) n++
  return n
}

/**
 * What changes a page's content from Notion's to the board's (content: a doc without its title):
 * one replacement per section whose text changed, or null when only the whole content will do (a
 * section added, removed, or renamed, an empty top gaining text, or an old text that isn't once in
 * the page).
 */
export function sectionUpdates(notion: string, board: string): { old_str: string; new_str: string }[] | null {
  const n = parseDoc(notion)
  const b = parseDoc(board)
  const keys = (sections: typeof n) => sections.map((section) => section.key).join('\n')
  if (keys(n) !== keys(b)) return null
  const updates: { old_str: string; new_str: string }[] = []
  for (let i = 0; i < n.length; i++) {
    const before = raw(n[i]!).trim()
    const after = raw(b[i]!).trim()
    if (before === after) continue
    if (!before || count(notion, before) !== 1) return null
    updates.push({ old_str: before, new_str: after })
  }
  return updates
}

/** Notion as a sync provider: pages in as docs, and back out when two-way. */
export function notionProvider(options: NotionOptions): SyncProvider<NotionEvent> {
  const api = (options.apiBase ?? 'https://api.notion.com').replace(/\/+$/, '')
  const token = secretReader(options.token, 'the Notion token')
  const webhookSecret = options.webhookSecret === undefined ? null : secretReader(options.webhookSecret, 'the Notion webhook secret')
  const pages = new Map(Object.entries(options.pages).map(([id, page]) => [pageId(id), page]))

  const notion = async (method: string, path: string, body?: unknown): Promise<any> => {
    const response = await fetch(api + '/v1' + path, {
      method,
      headers: { authorization: 'Bearer ' + (await token()), 'notion-version': NOTION_VERSION, 'content-type': 'application/json' },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    })
    if (response.ok) return response.json()
    const text = (await response.text()).slice(0, 300)
    const said = 'Notion answered ' + response.status + ' to ' + method + ' ' + path + ': ' + text
    if (response.status === 429 || response.status >= 500) throw new SyncRetry(said)
    throw new SyncRefused(said)
  }

  /** The page as Notion holds it now: its title, its title property's name, and its content. */
  const read = async (page: string) => {
    const [meta, content] = await Promise.all([notion('GET', '/pages/' + page), notion('GET', '/pages/' + page + '/markdown?markdown_version=v2')])
    const [property, value] = (Object.entries(meta.properties ?? {}) as [string, any][]).find(([, value]) => value?.type === 'title') ?? ['title', { title: [] }]
    const title = (value.title ?? []).map((part: { plain_text?: string }) => part.plain_text ?? '').join('')
    if (content.truncated) throw new SyncRefused('the page ' + page + ' is too large for Notion to give whole: it stays as it is')
    return { title, property, markdown: String(content.markdown ?? ''), url: typeof meta.url === 'string' ? meta.url : 'https://www.notion.so/' + page }
  }

  const docAt = async (call: Call, path: string) =>
    call('docAt', { path, depth: 1 }).catch((error: { code?: string }) => {
      if (error?.code === 'doc_not_found') return null
      throw error
    })
  const synced = async (call: Call, id: string, revision: string) => call('label', { id, set: { [SYNCED_LABEL]: revision } })

  return {
    platform: 'notion',

    async receive(request, { key }) {
      const body = await request.text()
      let payload: any
      try {
        payload = JSON.parse(body)
      } catch {
        return { events: [], response: new Response('not JSON\n', { status: 400 }) }
      }
      const signature = request.headers.get('x-notion-signature')
      if (typeof payload?.verification_token === 'string' && payload.type === undefined) {
        // Notion's one-time check of a new subscription: the token goes in its Verify dialog, and in webhookSecret.
        console.log('[boards] sync ' + key + ": Notion's webhook verification token arrived: " + payload.verification_token + ' (paste it in the subscription' + "'" + 's Verify dialog, and set it as the webhook secret)')
        return { events: [] }
      }
      if (!webhookSecret) return { events: [], response: new Response('no webhook secret is set for this sync yet\n', { status: 401 }) }
      if (!signature || !(await verifyNotion(body, signature, await webhookSecret()))) return { events: [], response: new Response('not signed by this subscription\n', { status: 401 }) }
      const kinds = new Set(['page.content_updated', 'page.properties_updated', 'page.created', 'page.undeleted'])
      if (!kinds.has(payload.type) || payload.entity?.type !== 'page') return { events: [] }
      const page = pageId(String(payload.entity.id))
      if (!pages.has(page)) return { events: [] }
      const event: InboxEvent<NotionEvent> = { id: String(payload.id), thread: key + ':page:' + page, channel: key + ':pages', event: { kind: 'page', page }, raw: payload }
      return { events: [event] }
    },

    async import(event, { call }) {
      const page = pages.get(event.page)
      if (!page) return null
      const path = page.channel + '/' + page.slug
      const now = await read(event.page)
      const after = docText(now.title, now.markdown)
      const file = { channel: page.channel, slug: page.slug, after, name: 'The Notion page ' + JSON.stringify(now.title), link: now.url }
      if (!page.twoWay) return importDocFile(call, { ...file, before: null, mirror: true })
      // Two-way: the base is what Notion last held, as the board recorded it.
      const found = await docAt(call, path)
      const at = found ? ((await call('message', { id: found.doc.id, limit: 1 })).message.labels?.[SYNCED_LABEL] as string | undefined) : undefined
      const before = found ? (at ? (await call('doc', { id: found.doc.id, revision: at })).body : found.body ?? (await call('doc', { id: found.doc.id })).body) : null
      const done = await importDocFile(call, { ...file, before })
      // When the doc now says what Notion does, that's the next base; otherwise the courier writes it there and records it.
      const doc = await docAt(call, path)
      if (doc && (await call('doc', { id: doc.doc.id })).body === after) await synced(call, doc.doc.id, doc.doc.revision)
      return done
    },

    async post() {
      throw new SyncRefused('a Notion sync keeps docs, not messages')
    },

    docTarget(path, key) {
      for (const [id, page] of pages) if (page.channel + '/' + page.slug === path) return key + ':' + id
      return null
    },

    async doc(input, { key, call }) {
      const id = input.target.slice(key.length + 1).split(':')[0]!
      const page = pages.get(id)
      if (!page?.twoWay || input.event === 'moved') return
      const now = await read(id)
      const notionDoc = docText(now.title, now.markdown)
      const want = pageText(input.body)
      if (notionDoc !== input.body) {
        if (want.title !== null && want.title !== now.title) await notion('PATCH', '/pages/' + id, { properties: { [now.property]: { title: [{ type: 'text', text: { content: want.title.slice(0, 2000) } }] } } })
        const updates = sectionUpdates(now.markdown, want.markdown)
        let replaced = updates === null
        if (updates !== null && updates.length) {
          const answer = await notion('PATCH', '/pages/' + id + '/markdown', { markdown_version: 'v2', type: 'update_content', update_content: { content_updates: updates.slice(0, 100) } })
          replaced = updates.length > 100 || (answer?.warnings ?? []).length > 0
        }
        // The whole content, when the sections changed shape or a replacement didn't land. Child pages and databases are never deleted.
        if (replaced) await notion('PATCH', '/pages/' + id + '/markdown', { markdown_version: 'v2', type: 'replace_content', replace_content: { new_str: want.markdown } })
      }
      if (call) await synced(call, input.doc.id, input.doc.revision)
    },
  }
}

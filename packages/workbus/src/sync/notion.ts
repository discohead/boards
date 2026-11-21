// Notion, as a platform the board keeps docs in step with: each page it's given is a board doc, its
// title the doc's first heading and its content the rest, in Notion-flavored Markdown. A page is a
// mirror (one-way: the doc is what Notion says, and only Notion changes it) or two-way. A two-way
// page and its doc are reconciled whenever either changes (Notion's webhook, or a write on the
// board): the two merge by section against what Notion last held, and each side gets what it lacks.
// Notion gets one exact replacement per section that changes there, so the blocks nobody changed
// (and their comments) stay as they are. When both changed a section, the board's text stands on
// both sides and a task in the doc's channel keeps Notion's.
import { importDocFile } from './docfiles.ts'
import { merge, parseDoc, raw } from '../ledger/doctext.ts'
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

/** Notion's doc with these sections as they were in base: what a conflict's merge takes instead, so the other side's text stands. */
export function revert(notion: string, base: string, keys: string[]): string {
  const was = new Map(parseDoc(base).map((section) => [section.key, raw(section)]))
  const sections = parseDoc(notion).map((section) => ({ key: section.key, text: raw(section) }))
  const out = sections.filter((section) => !keys.includes(section.key) || was.has(section.key)).map((section) => (keys.includes(section.key) ? { key: section.key, text: was.get(section.key)! } : section))
  // A section Notion removed, put back where base had it.
  const order = [...was.keys()]
  for (const key of keys) {
    if (!was.has(key) || out.some((section) => section.key === key)) continue
    const prior = order.slice(0, order.indexOf(key)).reverse().find((other) => out.some((section) => section.key === other))
    const at = prior === undefined ? 0 : out.findIndex((section) => section.key === prior) + 1
    out.splice(at, 0, { key, text: was.get(key)! })
  }
  return out.map((section, i) => (section.text !== '' && i < out.length - 1 && !section.text.endsWith('\n\n') ? section.text.replace(/\n?$/, '\n\n') : section.text)).join('')
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

  /** Notion's content made the merged doc's: a replacement per section, or the whole of it when sections came or went. */
  const write = async (page: string, now: Awaited<ReturnType<typeof read>>, body: string) => {
    const want = pageText(body)
    if (want.title !== null && want.title !== now.title) await notion('PATCH', '/pages/' + page, { properties: { [now.property]: { title: [{ type: 'text', text: { content: want.title.slice(0, 2000) } }] } } })
    if (want.markdown === now.markdown.trim()) return
    const updates = sectionUpdates(now.markdown, want.markdown)
    if (updates === null || updates.length > 100) {
      // Child pages and databases are never deleted: Notion refuses the write instead.
      await notion('PATCH', '/pages/' + page + '/markdown', { markdown_version: 'v2', type: 'replace_content', replace_content: { new_str: want.markdown } })
      return
    }
    const answer = await notion('PATCH', '/pages/' + page + '/markdown', { markdown_version: 'v2', type: 'update_content', update_content: { content_updates: updates } })
    // A replacement that missed: the page changed since it was read. Read it again on the next try.
    if ((answer?.warnings ?? []).length) throw new SyncRetry('the Notion page ' + page + ' changed while it was written: ' + JSON.stringify(answer.warnings).slice(0, 200))
  }

  /** A two-way page and its doc, made the same: merged by section against what Notion last held. */
  const reconcile = async (call: Call, page: string, config: NotionPage) => {
    const path = config.channel + '/' + config.slug
    const now = await read(page)
    const notionDoc = docText(now.title, now.markdown)
    const found = await docAt(call, path)
    if (!found) {
      const made = await call('createDoc', { channel: config.channel, slug: config.slug, body: notionDoc })
      await synced(call, made.message.id, made.message.doc.revision)
      return made
    }
    const id: string = found.doc.id
    const board: string = found.body
    const at = (await call('message', { id, limit: 1 })).message.labels?.[SYNCED_LABEL] as string | undefined
    // What Notion last held; with no record of it yet, the board's (so Notion's differences come in).
    const base: string = at ? (await call('doc', { id, revision: at })).body : board
    let merged = merge(base, board, notionDoc)
    if ('conflicts' in merged) {
      // Both changed these sections: the board's text stands, and a task keeps Notion's.
      const keys = merged.conflicts
      const theirs = new Map(parseDoc(notionDoc).map((section) => [section.key, raw(section).trim()]))
      const quoted = keys.map((key) => '\u0060' + (key || '(the top)') + '\u0060 in Notion said:\n\n' + (theirs.get(key) ?? '(removed there)').split('\n').map((line) => '> ' + line).join('\n')).join('\n\n')
      await call('createTask', { channel: config.channel, text: 'The Notion page ' + JSON.stringify(now.title) + ' and [[' + path + ']] both changed ' + keys.map((key) => '\u0060' + (key || '(the top)') + '\u0060').join(', ') + '. The doc kept its text, and Notion has it now too. What Notion had is below: fold in what should stay, then complete this task.\n\n' + quoted.slice(0, 8000) })
      merged = merge(base, board, revert(notionDoc, base, keys))
      if ('conflicts' in merged) throw new SyncRefused('the Notion page ' + page + " and its doc couldn't be merged: " + merged.conflicts.join(', '))
    }
    let revision: string = found.doc.revision
    if (merged.body !== board) revision = (await call('editDoc', { id, revision, body: merged.body })).revision
    if (merged.body !== notionDoc) await write(page, now, merged.body)
    if (at !== revision) await synced(call, id, revision)
    return { revision }
  }

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
        console.log('[workbus] sync ' + key + ": Notion's webhook verification token arrived: " + payload.verification_token + ' (paste it in the subscription' + "'" + 's Verify dialog, and set it as the webhook secret)')
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
      return reconcile(call, event.page, page)
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
      if (!page?.twoWay || input.event === 'moved' || !call) return
      await reconcile(call, id, page)
    },
  }
}

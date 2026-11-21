// The suite's sync provider: a platform that's only this isolate. Its webhooks are JSON a test
// writes (signed by an x-test-signature of "good"), what it imports and posts is recorded here, and
// a message's text scripts how it fails. The board runs it as its own sync under the key "test".
import { SyncRefused, type InboxEvent, type SyncProvider } from '../src/sync/provider.ts'
import { importDocFile } from '../src/sync/docfiles.ts'

export type TestEvent =
  | { kind: 'root'; thread: string; message: string; channel: string; text: string }
  | { kind: 'reply'; thread: string; message: string; text: string }
  /** Fails its first `fails` tries (all of them for a big number), then imports nothing. */
  | { kind: 'flaky'; thread: string; message: string; fails: number }
  /** The platform changed a thread's labels: imported as the sync, which its courier never copies back. */
  | { kind: 'labels'; thread: string; message: string; set: Record<string, string> }
  /** The platform's copy of a doc changed: imported as the GitHub provider imports a pushed Markdown file. */
  | { kind: 'docfile'; thread: string; message: string; channel: string; slug: string; before: string | null; after: string; mirror?: boolean }

export type Imported = { board: string; id: string; thread: string; attempt: number; ok: boolean; at: number }
export type Sent = { board: string; op: 'post' | 'edit' | 'delete' | 'react' | 'typing' | 'doc' | 'labels' | 'task'; set?: Record<string, string>; unset?: string[]; state?: string | null; event?: string; path?: string; from?: string; target: string; thread: string | null; message: string | null; text?: string; copy?: string; at: number; ok: boolean }

export const imported: Imported[] = []
export const sent: Sent[] = []
const tries = new Map<string, number>()
let copies = 0

const author = (key: string) => ({ id: key + ':user:u1', handle: 'ada', name: 'Ada', avatar: null, isBot: false })
const boardOf = (thread: string) => thread.split(':')[1]!

/** A failure a message's text asks for: fail-<op>-<n> fails n tries; fail-<op>-always every one. */
function scripted(op: string, id: string, text: string) {
  const found = text.match(new RegExp('fail-' + op + '-(\\d+|always|refused)'))
  if (!found) return
  if (found[1] === 'refused') throw new SyncRefused('the platform refused it')
  const n = (tries.get(op + id) ?? 0) + 1
  tries.set(op + id, n)
  if (found[1] === 'always' || n <= Number(found[1])) throw new Error('the platform failed ' + op + ' (try ' + n + ')')
}

export function testProvider(): SyncProvider<TestEvent & { board: string }> {
  return {
    platform: 'test',
    // Docs under docsync/<board> are kept in step: the channel's second segment is the board, so a test reads its own.
    docTarget(path, key) {
      const [top, board] = path.split('/')
      return top === 'docsync' && board ? key + ':' + board + ':doc' : null
    },
    async labels({ targets, root, set, unset }) {
      const target = targets[0]!
      sent.push({ board: boardOf(target), op: 'labels', target, thread: null, message: root.id, set, unset, at: Date.now(), ok: true })
    },
    async task({ targets, root }) {
      const target = targets[0]!
      sent.push({ board: boardOf(target), op: 'task', target, thread: null, message: root.id, state: root.task?.state ?? null, at: Date.now(), ok: true })
    },
    async doc({ target, event, doc, body, from }) {
      sent.push({ board: boardOf(target), op: 'doc', event, target, thread: null, message: doc.revision, path: doc.path, text: body, ...(from ? { from } : {}), at: Date.now(), ok: true })
    },
    async receive(request, { key }) {
      if (request.headers.get('x-test-signature') !== 'good') return { events: [], response: new Response('not signed\n', { status: 401 }) }
      const body = (await request.json()) as { board: string; events: (TestEvent & { id: string })[] }
      const events: InboxEvent<TestEvent & { board: string }>[] = body.events.map((event) => ({ id: event.id, thread: key + ':' + body.board + ':' + event.thread, channel: key + ':' + body.board, event: { ...event, board: body.board }, raw: { delivered: event } }))
      return { events }
    },
    async import(event, tools) {
      const thread = tools.key + ':' + event.board + ':' + event.thread
      const record = (ok: boolean) => imported.push({ board: event.board, id: event.message, thread: event.thread, attempt: tools.attempt, ok, at: Date.now() })
      // Its tries so far, replays included: an outage fails the first n, however they're counted.
      const tries = imported.filter((entry) => entry.board === event.board && entry.id === event.message).length + 1
      if (event.kind === 'flaky' && tries <= event.fails) {
        record(false)
        throw new Error('flaky import, try ' + tools.attempt)
      }
      record(true)
      if (event.kind === 'flaky') return { message: null }
      if (event.kind === 'labels') return tools.call('syncImport', { op: 'labels', from: tools.key, author: author(tools.key), origin: { thread }, set: event.set, unset: [] })
      if (event.kind === 'docfile') return importDocFile(tools.call, { channel: event.channel, slug: event.slug, before: event.before, after: event.after, name: event.thread, link: 'https://platform.test/' + event.thread, ...(event.mirror ? { mirror: true } : {}) })
      const origin = { channel: tools.key + ':' + event.board, thread, subthread: null, message: event.message, context: null }
      if (event.kind === 'root') return tools.call('syncImport', { op: 'post', from: tools.key, author: author(tools.key), origin, channel: event.channel, text: event.text, labels: {}, id: thread + ':' + event.message })
      const re = await tools.rootOf(thread)
      if (!re) return { message: null }
      return tools.call('syncImport', { op: 'post', from: tools.key, author: author(tools.key), origin, re, text: event.text, id: thread + ':' + event.message })
    },
    async post({ target, thread, message }, { key }) {
      const board = boardOf(target)
      try {
        scripted('post', message.id + '@' + target, message.text)
      } catch (error) {
        sent.push({ board, op: 'post', target, thread, message: message.id, text: message.text, at: Date.now(), ok: false })
        throw error
      }
      const copy = 'p' + ++copies
      sent.push({ board, op: 'post', target, thread, message: message.id, text: message.text, copy, at: Date.now(), ok: true })
      return { thread: thread ?? key + ':' + board + ':' + copy, message: copy }
    },
    async edit({ target, copy, message }) {
      const ok = !message.text.includes('fail-edit')
      sent.push({ board: boardOf(target), op: 'edit', target, thread: copy.thread, message: message.id, text: message.text, copy: copy.message, at: Date.now(), ok })
      if (!ok) throw new Error('the platform failed the edit')
    },
    async delete({ target, copy }) {
      sent.push({ board: boardOf(target), op: 'delete', target, thread: copy.thread, message: null, copy: copy.message, at: Date.now(), ok: true })
    },
    async react({ target, copy, emoji }) {
      sent.push({ board: boardOf(target), op: 'react', target, thread: copy.thread, message: null, text: emoji, copy: copy.message, at: Date.now(), ok: true })
    },
    async startTyping({ target, thread, status }) {
      sent.push({ board: boardOf(target), op: 'typing', target, thread, message: null, ...(status ? { text: status } : {}), at: Date.now(), ok: true })
    },
  }
}

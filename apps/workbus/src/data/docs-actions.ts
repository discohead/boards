// Doc writes, optimistic like the rest (actions.ts): a section edit shows in the open body at once
// and settles when the feed has brought the edit's own event (its answer's revision is that
// event's cursor); a comment shows at once and settles on its echo. A refusal rolls back. A 409
// section_conflict comes back to the view as a DocConflict, so the editor's text is never lost.
// TODO(step 2): settle on the client ID once editDoc takes one (reader's events carry it).
import { safeRandomUUID } from '@tanstack/db'
import { withSection } from '@/docs/sections'
import { BusRefusal } from './client.ts'
import { action, sendAndSettle } from './settle.ts'
import type { Bus } from './index.ts'
import type { Message } from './types.ts'

/** The board refused a section edit: someone changed that section after the revision it was made at. */
export class DocConflict extends Error {
  section: string
  revision: string
  constructor(section: string, revision: string, message: string) {
    super(message)
    this.name = 'DocConflict'
    this.section = section
    this.revision = revision
  }
}

export function docsActions(bus: Bus) {
  const { db, runtime } = bus
  const { client } = runtime
  const feed = runtime.feed!

  /** Read the doc again, kept where it's no older than what's here. */
  const reread = async (id: string) => {
    const page = await client.get<{ doc: { revision: string }; body: string }>('/docs/' + id)
    bus.bodies.utils.rows.merge([{ id, revision: page.doc.revision, body: page.body }], (row) => Number(row.revision))
  }

  /** Replace one section's own text, as of the revision the editor read. */
  const editSection = action<{ id: string; section: string; text: string; revision: string }>(db, {
    onMutate: ({ id, section, text }) => {
      bus.bodies.update(id, (row) => {
        row.body = withSection(row.body, section, text)
      })
    },
    mutationFn: async ({ id, section, text, revision }) => {
      try {
        await sendAndSettle(feed, () => client.post<{ revision: string }>('/docs/' + id + '/edit', { revision, edits: [{ section, text }] }), { cursor: (answer) => Number(answer.revision) }, () => reread(id))
      } catch (error) {
        if (error instanceof BusRefusal && error.code === 'section_conflict') {
          // Bring the body up to date, so the view can show what's there now beside the editor's text.
          await reread(id)
          throw new DocConflict(section, bus.bodies.utils.rows.get(id)?.revision ?? revision, error.message)
        }
        throw error
      }
    },
  })

  /** A comment on a doc: a reply, on one section (its key) or on the whole doc. */
  const comment = action<{ doc: string; text: string; section?: string; id?: string }>(db, {
    onMutate: (input) => {
      const id = (input.id ??= 'web-' + safeRandomUUID())
      bus.messages.insert({
        id,
        channel: bus.messages.get(input.doc)?.channel ?? bus.docs.get(input.doc)?.channel ?? '',
        text: input.text,
        re: input.doc,
        replyTo: null,
        thread: input.doc,
        labels: input.section !== undefined ? { 'board.doc.section': input.section } : {},
        reactions: {},
        by: { actor: runtime.me.actor, principal: runtime.me.actor, profile: null },
        createdAt: new Date().toISOString(),
        editedAt: null,
        deleted: false,
        version: 0,
        revision: 0,
        pending: id,
      } satisfies Message)
    },
    mutationFn: async (input) => {
      await sendAndSettle(
        feed,
        async () => (await client.post<{ message: Message }>('/messages', { re: input.doc, text: input.text, id: input.id, ...(input.section !== undefined ? { section: input.section } : {}) })).message,
        { cursor: (message) => message.version },
        (message) => bus.messages.utils.rows.merge([message], (row) => row.version),
      )
    },
  })

  return { editSection, comment }
}

export type DocsActions = ReturnType<typeof docsActions>

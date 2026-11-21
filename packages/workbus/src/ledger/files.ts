// Files: what the board knows of each upload (the files table, never the board log), who may
// have one, and what a write that carries files gets. The bytes are in R2, streamed by the Gateway.
import { WorkbusError, forbidden } from '../errors.ts'
import { hooks, op, type Ctx } from './ops.ts'

export type Attachment = { id: string; name: string; type: string; size: number }
type FileRow = { id: string; name: string; type: string; size: number; sha256: string | null; uploader: string | null; at: number }

export const attachmentNotFound = (id: string) => new WorkbusError(404, 'attachment_not_found', 'no attachment: ' + id)
const ID = /^(?:[A-Za-z0-9_-]{22}|att_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/

/** Uploading, either way, takes post or sync in some channel. */
export function mayUpload(ctx: Ctx) {
  if (!ctx.access.anywhere('post') && !ctx.access.anywhere('sync')) throw forbidden("this token can't post anywhere, so it can't upload")
}

/** A file the caller may have: it reads every channel, uploaded it, or reads a message that carries it. */
export function fileFor(ctx: Ctx, id: string): Attachment {
  const row = ID.test(id) ? ctx.sql.one<FileRow>('select * from files where id = ?', id) : null
  if (!row) throw attachmentNotFound(id)
  const may =
    row.uploader === ctx.caller.principal.id ||
    ctx.access.everywhere('read') ||
    ctx.sql.all<{ channel: string }>("select distinct m.channel from terms t join messages m on m.id = t.message where t.term = ?1 and m.deleted = 0 union select c.channel from terms t join cold_threads c on c.root = t.root and c.state = 'cold' where t.term = ?1 union select f.channel from frozen_files f where f.term = ?1", '^' + id).some((message) => ctx.access.readable(message.channel))
  if (!may) throw attachmentNotFound(id)
  return { id: row.id, name: row.name, type: row.type, size: row.size }
}

hooks.attachments = (ctx, ids) => ids.map((id) => fileFor(ctx, id))

// The Gateway's half of an upload: may this caller upload (before the body is read), then the
// record once the bytes are in R2. Neither has a route of its own.
op('fileUploadable', (ctx) => {
  mayUpload(ctx)
  return { ok: true }
}, { read: true })

op('fileRecord', (ctx, file: { id: string; name: string; type: string; size: number; sha256: string | null }) => {
  mayUpload(ctx)
  ctx.sql.run('insert into files (id, name, type, size, sha256, uploader, at) values (?, ?, ?, ?, ?, ?, ?)', file.id, file.name, file.type, file.size, file.sha256, ctx.caller.principal.id, ctx.now)
  return { attachment: { id: file.id, name: file.name, type: file.type, size: file.size } satisfies Attachment }
})

/** A download's metadata, when the caller may have the file: 404 attachment_not_found otherwise. */
op('fileReadable', (ctx, { id }: { id: string }) => ({ attachment: fileFor(ctx, id) }), { read: true })
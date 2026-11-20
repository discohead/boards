// The files routes. The Gateway serves them itself: it streams the bytes to and from R2 (binding
// FILES, keys boards/<board>/files/<id>), and asks the board's Ledger who may upload, records each
// file, and says who may have one.
//
// Direct uploads (a signed URL the client PUTs to) answer 501 no_direct_uploads: R2 presigned URLs
// are signed with S3 API credentials, which a Worker's R2 binding doesn't have. Files are at most
// 4 MiB, through POST /attachments.
import { z } from 'zod'
import { badRequest, BoardsError, failureResponse, notFound, notKept, type Failure } from '../errors.ts'
import type { GatewayEnv, LedgerStub, Mount } from '../gateway/gateway.ts'
import type { Caller } from '../ledger/core.ts'
import { AttachmentId } from './fields.ts'
import { GATEWAY, route } from './routes.ts'

export const ATTACHMENT_BYTES_MAX = 4 * 1024 * 1024
export const DIRECT_UPLOAD_BYTES_MAX = 100 * 1024 * 1024

export const UploadStartBody = z.object({
  name: z.string().max(1024).nullable().optional(),
  type: z.string().max(1024).nullable().optional(),
  size: z.number().int().positive().max(DIRECT_UPLOAD_BYTES_MAX, 'direct uploads are at most 100 MB'),
  sha256: z.string().regex(/^[A-Za-z0-9+/]{43}=$/, 'sha256 is the base64 SHA-256 of the bytes').optional(),
})

// The body is raw bytes, read by the Gateway's handler once the caller is verified.
route({ name: 'upload', method: 'POST', path: '/attachments', status: 201, gateway: true })
route({ name: 'attachment', method: 'GET', path: '/attachments/:id', gateway: true })
route({ name: 'uploadStart', method: 'POST', path: '/attachments/uploads', body: UploadStartBody, gateway: true })
// The body is not read: clients send {}.
route({ name: 'uploadFinish', method: 'POST', path: '/attachments/uploads/:id', status: 201, gateway: true })

// -- names and types ----------------------------------------------------------------------------

const MEDIA_TYPE = /^[a-z0-9][a-z0-9!#$&^_.+-]*\/[a-z0-9][a-z0-9!#$&^_.+-]*$/
export function mediaType(value: string | null | undefined): string {
  const type = (value ?? '').split(';')[0]!.trim().toLowerCase()
  return type.length <= 255 && MEDIA_TYPE.test(type) ? type : 'application/octet-stream'
}

/** A name as the board keeps it: its last path segment, no control characters, at most 255. */
export function fileName(name: string): string {
  const last = name.split(/[\/\\]/).at(-1) ?? ''
  const clean = last.replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, 255)
  return clean === '' ? 'file' : clean
}

/** Refuses a name that would download as a dotfile, or that hides characters. */
export function checkName(name: string): void {
  if (name.startsWith('.')) throw badRequest("attachment names can't start with a dot: " + JSON.stringify(name), 'invalid_attachment')
  if (/[\p{Cf}\u2028\u2029]/u.test(name)) throw badRequest("attachment names can't hold invisible formatting characters: " + JSON.stringify(name), 'invalid_attachment')
}

const INLINE = /^(image\/(png|jpeg|gif|webp|avif)|video\/(mp4|webm)|text\/plain)$/

// -- the Gateway's handlers ------------------------------------------------------------------------

type FilesEnv = GatewayEnv & { FILES?: R2Bucket }
const bucketOf = (env: GatewayEnv): R2Bucket => {
  const bucket = (env as FilesEnv).FILES
  if (!bucket) throw notKept('no_files', 'this board keeps no files')
  return bucket
}
export const fileKey = (board: string, id: string) => 'boards/' + board + '/files/' + id
const tooLarge = () => new BoardsError(413, 'too_large', 'attachments are at most 4 MB')

/** A Ledger answer's value, or its failure thrown. */
async function must(ledger: LedgerStub, caller: Caller, method: string, input: unknown, mount: Mount): Promise<any> {
  const answer = await ledger.call(caller, method, input, mount)
  if (!answer.ok) throw Object.assign(new BoardsError(answer.failure.status, answer.failure.code, answer.failure.message), { failure: answer.failure })
  return answer.value
}

/** A handler's errors as the protocol's: the Gateway returns a handler's promise, so it can't catch them. */
function handler(fn: (request: Request, env: GatewayEnv, ctx: { mount: Mount; caller: Caller; params: Record<string, string>; input: unknown; ledger: LedgerStub }) => Promise<Response>) {
  return async (request: Request, env: GatewayEnv, ctx: { mount: Mount; caller: Caller | null; params: Record<string, string>; input: unknown; ledger: LedgerStub }) => {
    try {
      return await fn(request, env, { ...ctx, caller: ctx.caller! })
    } catch (error) {
      const failure = (error as { failure?: Failure }).failure
      if (failure) return failureResponse(failure)
      if (error instanceof BoardsError) return failureResponse(error.toFailure())
      console.error('[boards] files:', error)
      return failureResponse({ status: 500, code: 'internal', message: 'internal error' })
    }
  }
}

/** The body, read up to the cap and never past it. */
async function readCapped(request: Request, cap: number): Promise<Uint8Array> {
  if (!request.body) return new Uint8Array(0)
  const reader = request.body.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    total += value.byteLength
    if (total > cap) {
      await reader.cancel().catch(() => {})
      throw tooLarge()
    }
    chunks.push(value)
  }
  const out = new Uint8Array(total)
  let at = 0
  for (const chunk of chunks) out.set(chunk, at), (at += chunk.byteLength)
  return out
}

/** 128 random bits, base64url: 22 characters, never starting with -. */
export function newId(): string {
  for (;;) {
    const bytes = crypto.getRandomValues(new Uint8Array(16))
    const id = btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
    if (!id.startsWith('-')) return id
  }
}

GATEWAY.upload = handler(async (request, env, { mount, caller, ledger }) => {
  const header = request.headers.get('x-board-filename')
  let name = 'file'
  if (header !== null) {
    try {
      name = decodeURIComponent(header)
    } catch {
      throw badRequest('\u0060x-board-filename\u0060 is not URI-encoded')
    }
  }
  const length = request.headers.get('content-length')
  if (length !== null && Number(length) > ATTACHMENT_BYTES_MAX) throw tooLarge()
  await must(ledger, caller, 'fileUploadable', {}, mount)
  const bucket = bucketOf(env)
  const bytes = await readCapped(request, ATTACHMENT_BYTES_MAX)
  if (bytes.byteLength === 0) throw badRequest('the file is empty')
  const clean = fileName(name)
  checkName(clean)
  const type = mediaType(request.headers.get('content-type'))
  const id = newId()
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))
  const key = fileKey(mount.name, id)
  await bucket.put(key, bytes, { httpMetadata: { contentType: type }, sha256: digest })
  const answer = await ledger.call(caller, 'fileRecord', { id, name: clean, type, size: bytes.byteLength, sha256: btoa(String.fromCharCode(...digest)) }, mount)
  if (!answer.ok) {
    await bucket.delete(key).catch(() => {})
    return failureResponse(answer.failure)
  }
  return Response.json(answer.value, { status: 201 })
})

GATEWAY.attachment = handler(async (_request, env, { mount, caller, params, ledger }) => {
  const bucket = bucketOf(env)
  const id = params.id!
  if (!AttachmentId.safeParse(id).success) throw notFound('no attachment: ' + id, 'attachment_not_found')
  const { attachment } = (await must(ledger, caller, 'fileReadable', { id }, mount)) as { attachment: { name: string; type: string; size: number } }
  const object = await bucket.get(fileKey(mount.name, id))
  if (!object) throw notFound('no attachment: ' + id, 'attachment_not_found')
  return new Response(object.body, {
    status: 200,
    headers: {
      'content-type': attachment.type,
      'content-length': String(attachment.size),
      'content-disposition': (INLINE.test(attachment.type) ? 'inline' : 'attachment') + "; filename*=UTF-8''" + encodeURIComponent(attachment.name),
      'content-security-policy': "sandbox; default-src 'none'",
      'x-content-type-options': 'nosniff',
      'cache-control': 'private, max-age=31536000, immutable',
    },
  })
})

GATEWAY.uploadStart = handler(async (_request, env, { mount, caller, input, ledger }) => {
  const body = input as z.infer<typeof UploadStartBody>
  await must(ledger, caller, 'fileUploadable', {}, mount)
  bucketOf(env)
  if (typeof body.name === 'string') checkName(fileName(body.name))
  if (body.size > DIRECT_UPLOAD_BYTES_MAX) throw new BoardsError(413, 'too_large', 'direct uploads are at most 100 MB')
  throw notKept('no_direct_uploads', "this board's blob store can't take direct uploads, so files are at most 4 MB")
})

GATEWAY.uploadFinish = handler(async (_request, env, { params }) => {
  bucketOf(env)
  // No upload ticket is ever issued here (see above), so every ID names none.
  throw notFound('no upload: ' + params.id, 'upload_not_found')
})

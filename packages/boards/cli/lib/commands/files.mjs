// Files: upload one to attach to a write, download one a message carries.
import { createHash } from 'node:crypto'
import { existsSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { basename, extname, join, resolve } from 'node:path'
import { required } from '../common.mjs'
import { Failure, failure, misuse } from '../failure.mjs'
import { bytes } from '../format.mjs'

const ONE_REQUEST_MAX = 4 * 1024 * 1024
const DIRECT_MAX = 100 * 1024 * 1024

const TYPES = {
  '.txt': 'text/plain', '.log': 'text/plain', '.md': 'text/markdown', '.csv': 'text/csv', '.json': 'application/json',
  '.html': 'text/html', '.xml': 'application/xml', '.yaml': 'application/yaml', '.yml': 'application/yaml',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp', '.avif': 'image/avif', '.svg': 'image/svg+xml',
  '.mp4': 'video/mp4', '.webm': 'video/webm', '.pdf': 'application/pdf', '.zip': 'application/zip', '.gz': 'application/gzip', '.tar': 'application/x-tar',
}

const typeOf = (path) => TYPES[extname(path).toLowerCase()] ?? 'application/octet-stream'

/** Upload one file: in one request up to 4 MB, as a direct upload past that. */
export async function uploadFile(ctx, path, type = typeOf(path)) {
  let data
  try {
    if (!statSync(path).isFile()) throw new Error('not a file')
    data = readFileSync(path)
  } catch {
    throw misuse('no_file', 'no file at ' + path)
  }
  const name = basename(path)
  const board = ctx.board()
  const doing = "couldn't upload " + name
  if (data.length > DIRECT_MAX) throw failure('too_large', doing + ': it is ' + bytes(data.length) + ', and a board takes files of at most 100 MB')
  if (data.length <= ONE_REQUEST_MAX) {
    const answer = await board.request(doing, 'POST', '/attachments', { bytes: data, headers: { 'content-type': type, 'x-board-filename': encodeURIComponent(name) } })
    return answer.attachment
  }
  let ticket
  try {
    ticket = await board.request(doing, 'POST', '/attachments/uploads', { body: { name, type, size: data.length, sha256: createHash('sha256').update(data).digest('base64') } })
  } catch (error) {
    if (error instanceof Failure && (error.reason === 'not_supported' || error.board?.code === 'no_direct_uploads'))
      throw new Failure({ reason: 'too_large', headline: doing + ': it is ' + bytes(data.length) + ', and this board takes files of at most 4 MB', origin: 'board', board: error.board })
    throw error
  }
  let put
  try {
    put = await fetch(ticket.url, { method: 'PUT', headers: ticket.headers ?? {}, body: data })
  } catch (error) {
    throw failure('unreachable', doing + ': the upload URL did not answer (' + (error?.cause?.code ?? error.message) + ')')
  }
  if (!put.ok) throw failure('upload_failed', doing + ': the upload URL answered ' + put.status)
  const answer = await board.request(doing, 'POST', '/attachments/uploads/' + encodeURIComponent(ticket.id), { body: {} })
  return answer.attachment
}

export const upload = {
  usage: 'boards upload <file> [--type <media type>]\n\nUpload a file and print its ID, to attach with --attach or in a write.',
  flags: { type: 'string' },
  async run(ctx) {
    const path = required(ctx.positionals[0], 'a file', 'boards upload')
    const attachment = await uploadFile(ctx, path, ctx.flags.type ?? typeOf(path))
    if (ctx.json) return ctx.emit({ attachment })
    ctx.print(['uploaded ' + attachment.name + '  ' + attachment.id + '  ' + bytes(attachment.size)])
  },
}

/** The name a download says, safe to write here: no path, no leading dot. */
function nameOf(disposition) {
  const found = /filename\*=UTF-8''([^;]+)/i.exec(disposition ?? '')
  let name = 'file'
  if (found) {
    try {
      name = decodeURIComponent(found[1])
    } catch {}
  }
  name = name.split(/[\\/]/).pop().replace(/[\u0000-\u001f\u007f]/g, '').replace(/^[.\s]+/, '').trim()
  return name || 'file'
}

export const download = {
  usage: 'boards download <attachment id> [--out <path>|-] [--force]\n\nSave a file under the name it was uploaded with, or at --out (- is stdout).',
  flags: { out: 'string', force: 'bool' },
  async run(ctx) {
    const id = required(ctx.positionals[0], 'an attachment ID', 'boards download')
    const response = await ctx.board().request("couldn't download " + id, 'GET', '/attachments/' + encodeURIComponent(id), { raw: true })
    const data = Buffer.from(await response.arrayBuffer())
    if (ctx.flags.out === '-') return ctx.write(data)
    const name = nameOf(response.headers.get('content-disposition'))
    let target = resolve(ctx.flags.out ?? name)
    if (ctx.flags.out && existsSync(target) && statSync(target).isDirectory()) target = join(target, name)
    if (existsSync(target) && !ctx.flags.force)
      throw failure('file_exists', "couldn't save " + id + ': ' + (ctx.flags.out ?? name) + ' is there already', [['boards', 'download', id, '--out', '<path>'], ['boards', 'download', id, '--force']])
    writeFileSync(target, data)
    if (ctx.json) return ctx.emit({ saved: { id, name, type: response.headers.get('content-type'), size: data.length, path: target } })
    ctx.print(['saved ' + (ctx.flags.out ?? name) + '  ' + bytes(data.length)])
  },
}

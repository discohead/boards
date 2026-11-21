// Files for the agent: an attachment's bytes, when the agent may have it, and new uploads, recorded
// on the board. The bytes live in R2 under the board's keys; the Ledger keeps who may read them.
import { checkName, fileKey, fileName, mediaType, newId } from 'workbus/protocol/files.ts'
import { boardCall, BOARD } from './board.ts'
import type { Env } from './env.ts'

export function filesFor(env: Env) {
  const board = boardCall(env)
  return {
    async get(id: string) {
      const found = await board('fileReadable', { id }).catch(() => null)
      if (!found) return null
      const object = await env.FILES.get(fileKey(BOARD, id))
      if (!object) return null
      return { bytes: new Uint8Array(await object.arrayBuffer()), name: found.attachment.name as string }
    },
    async put(name: string, type: string, bytes: Uint8Array): Promise<string> {
      if (bytes.byteLength > 4 * 1024 * 1024) throw new Error(name + ' is over 4 MB')
      await board('fileUploadable', {})
      const clean = fileName(name)
      checkName(clean)
      const id = newId()
      const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))
      await env.FILES.put(fileKey(BOARD, id), bytes, { httpMetadata: { contentType: mediaType(type) }, sha256: digest })
      const recorded = await board('fileRecord', { id, name: clean, type: mediaType(type), size: bytes.byteLength, sha256: btoa(String.fromCharCode(...digest)) })
      return recorded.attachment.id as string
    },
  }
}

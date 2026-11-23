// A git push's body, read just far enough to see its ref updates (policy.ts decides on them), then
// handed on whole, the pack included, without buffering the pack.
import { receivePackCommands, type RefUpdate } from './policy.ts'

/** A push's ref updates come first in its body; more than this before the flush is not a push we read. */
const COMMANDS_MAX = 1024 * 1024

export async function readCommands(stream: ReadableStream<Uint8Array> | null): Promise<{ updates: RefUpdate[]; body: ReadableStream<Uint8Array> } | null> {
  if (!stream) return null
  const reader = stream.getReader()
  let buffered = new Uint8Array(0)
  for (;;) {
    const parsed = receivePackCommands(buffered)
    if (parsed) {
      const head = buffered
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(head)
        },
        async pull(controller) {
          const { done, value } = await reader.read()
          if (done) controller.close()
          else controller.enqueue(value)
        },
        cancel(reason) {
          return reader.cancel(reason)
        },
      })
      return { updates: parsed.updates, body }
    }
    if (buffered.length > COMMANDS_MAX) return null
    const { done, value } = await reader.read()
    if (done) return null
    const next = new Uint8Array(buffered.length + value.byteLength)
    next.set(buffered)
    next.set(value, buffered.length)
    buffered = next
  }
}


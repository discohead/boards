// The courier: what's written on the board in a synced thread, copied to the platform. It's the
// Mailbox of a sync key's @sync:<key> subscription (the Ledger matches its events like any
// watcher's), so deliveries keep each thread's order. A post is retried until it lands (the receipt
// is the retry guard: an existing copy is never posted again), and after the last try the board
// records message.sync_failed and the thread goes on. Edits, deletes, and reactions are best-effort:
// one try, and they never hold a thread.
import { satelliteCall, SyncRefused, type Call, type Copy, type OutboundMessage, type SyncProvider } from './provider.ts'

type Ledger = Parameters<typeof satelliteCall>[0]
type View = { id: string; re: string | null; thread: string; text: string; from: string | null; noSync: boolean; deleted: boolean; author?: { name: string; handle: string } | null; doc?: { id: string; path: string; title: string; revision: string }; labels?: Record<string, string>; task?: { state: string } | null }
type Event = { cursor: string; type: string; payload: Record<string, any>; message?: View }

const keyOf = (target: string) => target.slice(0, target.indexOf(':'))
/** A target names a platform thread (key:channel:thread) or a channel (key:channel). */
const kindOf = (target: string): 'channel' | 'thread' => (target.slice(target.indexOf(':') + 1).includes(':') ? 'thread' : 'channel')
const outbound = (view: View): OutboundMessage => ({ id: view.id, re: view.re, thread: view.thread, text: view.text, author: view.author ? { name: view.author.name, handle: view.author.handle } : null })
const reason = (error: unknown) => String((error as Error)?.message ?? error).slice(0, 500)

/** One courier delivery: a match of the key's subscription, on its try (last: the Mailbox's last). */
export async function courier(input: { ledger: Ledger; key: string; provider: SyncProvider; event: Event; last: boolean }): Promise<void> {
  const { key, provider, event, last } = input
  const call = satelliteCall(input.ledger, key, 'courier')
  const tools = { key }
  const message = event.message
  if (!message) return


  /** Where each of the thread's targets (under this key) has it on the platform. */
  const targetsOf = async (thread: string) => {
    const sync = await call('syncThread', { thread })
    return { targets: (sync.targets as string[]).filter((target) => keyOf(target) === key), external: { ...(sync.external as Record<string, string>) } }
  }
  const copyOf = async (id: string, target: string): Promise<Copy | null> => (await call('syncCopies', { message: id })).copies?.[id]?.[target] ?? null

  // A doc: written to the platform as it is now, when it's attached (a new doc, or one moved into a
  // synced channel), edited, or moved. Retried until it lands; a provider's write that finds the
  // platform already holding this body does nothing, which is the retry guard.
  if (message.doc && (event.type.startsWith('doc.') || event.type === 'thread.synced')) {
    if (!provider.doc || message.deleted) return
    const only = event.type === 'thread.synced' ? String(event.payload.target) : null
    const kind = event.type === 'doc.edited' ? 'edited' : event.type === 'doc.moved' ? 'moved' : 'created'
    const { targets } = await targetsOf(message.thread)
    for (const target of targets) {
      if (only !== null && target !== only) continue
      try {
        await provider.doc({ target, event: kind, doc: { id: message.doc.id, path: message.doc.path, title: message.doc.title, revision: message.doc.revision }, body: message.text, ...(kind === 'moved' ? { from: String(event.payload.path), to: String(event.payload.to) } : {}), ...(event.payload.by?.actor ? { by: String(event.payload.by.actor) } : {}) }, { key, call })
      } catch (error) {
        if (!last && !(error instanceof SyncRefused)) throw error
        console.warn('[workbus] sync ' + key + ': ' + event.type + ' of doc #' + message.id + ' not written to ' + target + ':', reason(error))
      }
    }
    return
  }

  // A root's labels or task, for a provider that keeps them (GitHub Projects): best-effort, one try.
  if ((event.type === 'labels.changed' && provider.labels) || (event.type.startsWith('task.') && provider.task)) {
    if (message.re !== null || message.deleted) return
    try {
      const { targets } = await targetsOf(message.thread)
      const root = { id: message.id, labels: message.labels ?? {}, task: message.task ? { state: message.task.state } : null }
      if (event.type === 'labels.changed') await provider.labels!({ targets, root, set: (event.payload.set ?? {}) as Record<string, string>, unset: (event.payload.unset ?? []) as string[] }, { key, call })
      else await provider.task!({ targets, root }, { key, call })
    } catch (error) {
      console.warn('[workbus] sync ' + key + ': ' + event.type + ' of #' + message.id + ' not copied:', reason(error))
    }
    return
  }
  if (event.type.startsWith('task.')) return

  if (event.type === 'message.posted' || event.type === 'thread.synced') {
    const only = event.type === 'thread.synced' ? String(event.payload.target) : null
    // A thread attached to a target backfills it in order: its root, then its replies.
    const messages: View[] = only ? await call('message', { id: message.id, limit: 500 }).then((thread: { message: View; replies: View[] }) => [thread.message, ...thread.replies]) : [message]
    const { targets, external } = await targetsOf(message.thread)
    for (const target of targets) {
      if (only !== null && target !== only) continue
      try {
        for (const view of messages) await postOne(call, provider, tools, view, target, external, last)
      } catch (error) {
        if (!last) throw error
        // The last try: what didn't go is said so on the board, and the thread goes on.
        for (const view of messages) if (!view.deleted && view.from !== key && !view.noSync && !(await copyOf(view.id, target))) await call('syncReceipt', { kind: 'failed', message: view.id, target, error: reason(error) }).catch(() => {})
      }
    }
    return
  }

  // The rest are best-effort: one try, logged when it fails, and the thread goes on.
  try {
    const { targets } = await targetsOf(message.thread)
    for (const target of targets) {
      const copy = await copyOf(message.id, target)
      if (!copy) continue
      if (event.type === 'message.edited' && provider.edit && !message.deleted) await provider.edit({ target, copy, message: outbound(message) }, tools)
      else if (event.type === 'message.deleted' && provider.delete) await provider.delete({ target, copy }, tools)
      else if ((event.type === 'reaction.added' || event.type === 'reaction.removed') && provider.react) await provider.react({ target, copy, emoji: String(event.payload.emoji), remove: event.type === 'reaction.removed' }, tools)
    }
  } catch (error) {
    console.warn('[workbus] sync ' + key + ': ' + event.type + ' of #' + message.id + ' not copied:', reason(error))
  }
}

/** A message posted to one target, once: its copy, an existing one, or null when it doesn't go. */
async function postOne(call: Call, provider: SyncProvider, tools: { key: string }, view: View, target: string, external: Record<string, string>, last: boolean): Promise<Copy | null> {
  // The retry guard: what has a copy there is never posted again.
  const existing: Copy | null = (await call('syncCopies', { message: view.id })).copies?.[view.id]?.[target] ?? null
  if (existing) return existing

  // Its echo (it came from this key), what's held back, and what's gone stay on the board.
  if (view.deleted || view.from === tools.key || view.noSync) return null
  let thread: string | null = external[target] ?? (kindOf(target) === 'thread' ? target : null)
  if (view.re !== null && thread === null) {
    // A reply in a thread synced to a channel goes in the platform thread its root started there.
    const root: View = (await call('message', { id: view.re, limit: 1 })).message
    thread = (await postOne(call, provider, tools, root, target, external, last))?.thread ?? null
    if (thread === null) throw new SyncRefused('its thread' + "'" + 's root isn' + "'" + 't on ' + target)
  }
  let copy: Copy
  try {
    copy = await provider.post({ target, thread, message: outbound(view) }, tools)
  } catch (error) {
    if (!(error instanceof SyncRefused) && !last) throw error
    await call('syncReceipt', { kind: 'failed', message: view.id, target, error: reason(error) })
    return null
  }
  try {
    await call('syncReceipt', { kind: 'message', message: view.id, target, external: copy })
  } catch (error) {
    // The platform's echo of it came in first: it's on the board already, and on the platform once.
    if ((error as { code?: string }).code !== 'already_synced') throw error
  }
  if (view.re === null) external[target] = copy.thread
  return copy
}

/** Typing, from the Gateway: shown on each target's platform thread. Nothing is written. */
export async function typing(input: { ledger: Ledger; key: string; provider: SyncProvider; thread: string; targets: string[]; status?: string }): Promise<void> {
  if (!input.provider.startTyping) return
  const call = satelliteCall(input.ledger, input.key, 'courier')
  const sync = await call('syncThread', { thread: input.thread })
  const external = sync.external as Record<string, string>
  await Promise.all(
    input.targets.map((target) =>
      input.provider.startTyping!({ target, thread: external[target] ?? target, ...(input.status ? { status: input.status } : {}) }, { key: input.key }).catch((error) =>
        console.warn('[workbus] sync ' + input.key + ': typing on ' + target + ' failed:', reason(error)),
      ),
    ),
  )
}

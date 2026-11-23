// The principal's request a seat's work belongs to (org.request): every message, task, doc, and
// proposal a seat makes carries the id of the principal's message that started the work, so the
// app can show what was done for what (the timeline). Pure: a check runs it in node (scripts/request-check.mjs).
import type { RequestHint } from '../harness/types.ts'
import type { Delivered } from './seat.ts'

/** The label every message, task, doc, and proposal a seat makes carries: the principal's message that started the work. */
export const REQUEST = 'org.request'

/**
 * The request a wake-up belongs to: the one its message already carries (a task, a hand-off, a
 * proposal, a consult), or a person's message, which starts one. A seat's own schedule starts
 * none (null).
 */
export function requestOf(event: Delivered, rules: string[]): RequestHint | null {
  if (rules.every((rule) => /^schedules(-\d+)?$/.test(rule))) return null
  const message = event.message
  if (!message) return null
  const carried = message.labels?.[REQUEST]
  if (typeof carried === 'string' && carried) return { id: carried, via: 'label', reply: message.re !== null && message.re !== undefined }
  // A person's message (a DM, a mention, a reply) or task (one they made and assigned) starts one.
  if (message.author?.kind === 'person') return { id: String(message.id), via: 'person', reply: message.re !== null && message.re !== undefined }
  return null
}

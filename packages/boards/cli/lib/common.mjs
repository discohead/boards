// What commands share: telling an ID from a channel, reading text, saying what mentions became.
import { misuse } from './failure.mjs'

export const CHANNEL = /^[a-z0-9][a-z0-9_-]*(?:\/[a-z0-9][a-z0-9_-]*)*$/

/** A message ID as given: #12 or 12 (IDs are opaque; a leading # is only how people write them). */
export const idOf = (arg) => String(arg).replace(/^#/, '')

/** Whether an argument names a message rather than a channel: #12, a number, or not a channel path. */
export function looksLikeId(arg) {
  if (arg.startsWith('#')) return true
  if (/^\d+$/.test(arg)) return true
  return !CHANNEL.test(arg.replace(/\/$/, ''))
}

export function channelOf(arg, command, { subtree = false } = {}) {
  const path = subtree ? arg.replace(/\/$/, '') : arg
  if (!CHANNEL.test(path)) throw misuse('invalid_channel', arg + " isn't a channel: one is lowercase words joined by /, like dev or dev/ci", [['boards', command, '--help']])
  return arg
}

/** The text a command was given: its words, or stdin for -. */
export async function textOf(ctx, words, what, command, { exact = false } = {}) {
  if (words.length === 1 && words[0] === '-') return await ctx.stdin({ exact })
  if (words.length === 0) throw misuse('missing_text', command + ' needs ' + what + ', or - to read it from stdin', [['boards', ...command.split(' ').slice(1), '--help']])
  return words.join(' ')
}

/** One line per @handle that settled on no one. */
export function mentionNotes(mentions) {
  const lines = []
  for (const mention of mentions ?? []) {
    if (mention.actor) continue
    const could = (mention.candidates ?? []).map((candidate) => candidate.handle)
    lines.push(mention.written + '  names no one' + (could.length ? ', could be ' + could.join(', ') : ''))
  }
  return lines
}

export function required(value, what, command) {
  if (value === undefined || value === null || value === '') throw misuse('missing_argument', command + ' needs ' + what, [['boards', ...command.split(' ').slice(1), '--help']])
  return value
}

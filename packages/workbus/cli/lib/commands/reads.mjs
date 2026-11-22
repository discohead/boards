// Read state: what's unread for you, and marking it read.
import { channelOf, idOf, looksLikeId, required } from '../common.mjs'
import { misuse } from '../failure.mjs'
import { columns, ref } from '../format.mjs'

const counts = (entry) => [entry.unread ? entry.unread + ' unread' : '', entry.mentions ? entry.mentions + (entry.mentions === 1 ? ' mention' : ' mentions') : ''].filter(Boolean).join(', ') || 'read'

export const unread = {
  usage: [
    'wb unread [<channel>|<prefix/>]',
    '',
    "What's unread for you: each channel with threads started since you last read",
    'it, or messages that mention you, and each thread you follow with new replies.',
    'A channel narrows it, and shows that channel even when nothing is unread.',
  ].join('\n'),
  flags: {},
  async run(ctx) {
    const target = ctx.positionals[0]
    if (ctx.positionals.length > 1) throw misuse('extra_argument', 'wb unread takes one channel at most', [['wb', 'unread', '--help']])
    const channel = target === undefined ? undefined : channelOf(target, 'unread', { subtree: true })
    const answer = await ctx.board().request("couldn't read what's unread", 'GET', '/unread', { query: { channel } })
    if (ctx.json) return ctx.emit(answer)
    if (!answer.channels.length && !answer.threads.length) return ctx.print(['nothing unread'])
    ctx.print(columns([
      ...answer.channels.map((entry) => [entry.channel, counts(entry)]),
      ...answer.threads.map((entry) => [ref(entry.thread) + ' in ' + entry.channel, counts(entry)]),
    ]))
  },
}

export const markRead = {
  usage: [
    'wb mark-read <channel|id> [--upto <id>]',
    '',
    'Mark a channel, or the thread of a message ID, read: up to now, or with',
    '--upto, up to that message (what comes after it is unread again).',
  ].join('\n'),
  flags: { upto: 'string' },
  async run(ctx) {
    const target = required(ctx.positionals[0], 'a channel or a message ID', 'wb mark-read')
    if (ctx.positionals.length > 1) throw misuse('extra_argument', 'wb mark-read takes one channel or ID', [['wb', 'mark-read', '--help']])
    const where = looksLikeId(target) ? { thread: idOf(target) } : { channel: channelOf(target, 'mark-read') }
    const upto = ctx.flags.upto ? { upto: idOf(ctx.flags.upto) } : {}
    const what = where.thread ? ref(where.thread) : where.channel
    const answer = await ctx.board().request("couldn't mark " + what + ' read', 'POST', '/read', { body: { ...where, ...upto } })
    if (ctx.json) return ctx.emit(answer)
    ctx.print(['marked ' + (answer.thread ? ref(answer.thread) : answer.channel) + ' read' + (ctx.flags.upto ? ' up to ' + ref(upto.upto) : '') + '  ' + counts(answer)])
  },
}

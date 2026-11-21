// Who you are, channels, threads, and the writes on messages.
import { count, pairs } from '../args.mjs'
import { channelOf, idOf, looksLikeId, mentionNotes, required, textOf } from '../common.mjs'
import { misuse } from '../failure.mjs'
import { columns, fitted, labelText, messageBlock, oneLine, ref, when, who } from '../format.mjs'
import { uploadFile } from './files.mjs'

const PERMISSIONS = ['read', 'post', 'react', 'label', 'sync', 'manage']

export const whoami = {
  usage: 'boards whoami\n\nWho the board says you are, and what you may do where.',
  flags: {},
  async run(ctx) {
    const me = await ctx.board().request("couldn't read who you are", 'GET', '/me')
    if (ctx.json) return ctx.emit({ me })
    const can = Object.entries(me.can ?? {})
    const rows = [
      ['board', ctx.board().url],
      ['actor', me.actor],
      ['handle', me.handle],
      ['kind', me.kind],
    ]
    if (me.profile) rows.push(['profile', me.profile + (me.via ? ' (via ' + me.via.name + ')' : '')])
    rows.push(['expires', me.expiresAt ? when(me.expiresAt) : 'never'])
    if (!can.length) rows.push(['can', 'nothing'])
    const lines = columns(rows)
    const label = 'can'.padEnd(7)
    const patterns = columns(can.map(([pattern, permissions]) => [pattern, permissions.length === PERMISSIONS.length ? 'everything' : permissions.join(', ') || 'nothing']))
    patterns.forEach((line, i) => lines.push((i === 0 ? label : ' '.repeat(7)) + '  ' + line))
    ctx.print(lines)
  },
}

export const channels = {
  usage: 'boards channels [--prefix <p>] [--limit <n>]\n\nThe channels you can read.',
  flags: { prefix: 'string', limit: 'string' },
  async run(ctx) {
    const limit = count(ctx.flags.limit, '--limit')
    const found = []
    let after
    for (;;) {
      const page = await ctx.board().request("couldn't list channels", 'GET', '/channels', { query: { prefix: ctx.flags.prefix, after, limit: limit ? Math.min(limit - found.length, 500) : 500 } })
      found.push(...page.channels)
      after = page.next ?? null
      if (!after || (limit && found.length >= limit)) break
    }
    if (ctx.json) return ctx.emit({ channels: found, next: after ?? null })
    if (!found.length) return ctx.print(['no channels'])
    const plural = (n, one) => n + ' ' + one + (n === 1 ? '' : 's')
    ctx.print(columns(found.map((channel) => [channel.path, channel.threads === undefined ? '' : plural(channel.threads, 'thread'), channel.messages === undefined ? '' : plural(channel.messages, 'message')])))
  },
}

export const read = {
  usage: [
    'boards read <channel> [--label k=v]... [--after <cursor>] [--before <older>]',
    '                      [--limit <n>]',
    'boards read <id> [--after <id>] [--limit <n>]',
    '',
    'A channel (dev, or dev/ for it and the channels under it) lists its threads,',
    "most recently active last. An ID (12 or #12) reads that message's thread.",
  ].join('\n'),
  flags: { after: 'string', before: 'string', limit: 'string', label: 'list' },
  async run(ctx) {
    const target = required(ctx.positionals[0], 'a channel or a message ID', 'boards read')
    if (ctx.positionals.length > 1) throw misuse('extra_argument', 'boards read takes one channel or ID, not ' + ctx.positionals.length, [['boards', 'read', '--help']])
    const limit = count(ctx.flags.limit, '--limit')
    if (looksLikeId(target)) {
      if (ctx.flags.label || ctx.flags.before) throw misuse('invalid_flag', '--label and --before go with a channel, not a message ID', [['boards', 'read', '--help']])
      const id = idOf(target)
      const thread = await ctx.board().request("couldn't read " + ref(id), 'GET', '/messages/' + encodeURIComponent(id), { query: { after: ctx.flags.after && idOf(ctx.flags.after), limit } })
      if (ctx.json) return ctx.emit(thread)
      const lines = messageBlock(thread.message)
      for (const reply of thread.replies ?? []) lines.push('', ...messageBlock(reply))
      for (const schedule of thread.schedules ?? []) lines.push('', 'scheduled ' + schedule.id + '  next ' + when(schedule.next) + '  ' + oneLine(schedule.text))
      return ctx.print(lines)
    }
    const channel = channelOf(target, 'read', { subtree: true })
    const page = await ctx.board().request("couldn't read " + channel, 'GET', '/threads', {
      query: { channel, label: ctx.flags.label, after: ctx.flags.after && idOf(ctx.flags.after), before: ctx.flags.before, limit },
    })
    if (ctx.json) return ctx.emit({ threads: page.threads, cursor: page.cursor, older: page.older ?? null })
    if (!page.threads.length) return ctx.print(['no threads in ' + channel])
    const subtree = channel.endsWith('/')
    const rows = page.threads.map(({ message, replies }) => [
      ref(message.id),
      ...(subtree ? [message.channel] : []),
      who(message),
      replies + (replies === 1 ? ' reply' : ' replies'),
      (message.deleted ? '(deleted)' : oneLine(message.text) || '(files)') + (Object.keys(message.labels ?? {}).length ? '  [' + labelText(message.labels) + ']' : ''),
    ])
    const lines = fitted(rows)
    if (page.older) lines.push('', 'older  boards read ' + channel + ' --before ' + page.older)
    ctx.print(lines)
  },
}

async function attachAll(ctx) {
  const ids = []
  for (const path of ctx.flags.attach ?? []) ids.push((await uploadFile(ctx, path)).id)
  return ids
}

export const post = {
  usage: [
    'boards post <channel> <text|-> [--label k=v]... [--attach <file>]... [--id <id>]',
    '',
    'Start a thread. - reads the text from stdin. --id <id> names the post, so a',
    'retry with the same one is the same post.',
  ].join('\n'),
  flags: { label: 'list', attach: 'list', id: 'string' },
  async run(ctx) {
    const channel = channelOf(required(ctx.positionals[0], 'a channel', 'boards post'), 'post')
    const attachments = await attachAll(ctx)
    const words = ctx.positionals.slice(1)
    const text = words.length === 0 && attachments.length ? '' : await textOf(ctx, words, 'text', 'boards post')
    const labels = pairs(ctx.flags.label, '--label')
    const answer = await ctx.board().request("couldn't post in " + channel, 'POST', '/messages', {
      body: { channel, text, ...(Object.keys(labels).length ? { labels } : {}), ...(attachments.length ? { attachments } : {}), ...(ctx.flags.id ? { id: ctx.flags.id } : {}) },
    })
    if (ctx.json) return ctx.emit(answer)
    ctx.print(['posted ' + ref(answer.message.id) + ' in ' + answer.message.channel, ...mentionNotes(answer.mentions)])
  },
}

export const reply = {
  usage: [
    'boards reply <id> <text|-> [--attach <file>]... [--label k=v]... [--after <id>]',
    '                            [--id <client id>]',
    '',
    'Reply in the thread of <id>. --after <id> lands the reply only if nothing came',
    'after that message in the thread.',
  ].join('\n'),
  flags: { attach: 'list', label: 'list', after: 'string', id: 'string' },
  async run(ctx) {
    const re = idOf(required(ctx.positionals[0], 'a message ID', 'boards reply'))
    const attachments = await attachAll(ctx)
    const words = ctx.positionals.slice(1)
    const text = words.length === 0 && attachments.length ? '' : await textOf(ctx, words, 'text', 'boards reply')
    const labels = pairs(ctx.flags.label, '--label')
    const answer = await ctx.board().request("couldn't reply to " + ref(re), 'POST', '/messages', {
      body: {
        re,
        text,
        ...(Object.keys(labels).length ? { labels } : {}),
        ...(attachments.length ? { attachments } : {}),
        ...(ctx.flags.after ? { after: idOf(ctx.flags.after) } : {}),
        ...(ctx.flags.id ? { id: ctx.flags.id } : {}),
      },
    })
    if (ctx.json) return ctx.emit(answer)
    ctx.print(['replied ' + ref(answer.message.id) + ' in ' + ref(answer.message.re ?? re), ...mentionNotes(answer.mentions)])
  },
}

export const edit = {
  usage: 'boards edit <id> <text|-> [--revision <n>]\n\nReplace the text of a message you wrote.',
  flags: { revision: 'string' },
  async run(ctx) {
    const id = idOf(required(ctx.positionals[0], 'a message ID', 'boards edit'))
    const text = await textOf(ctx, ctx.positionals.slice(1), 'the new text', 'boards edit')
    const revision = count(ctx.flags.revision, '--revision')
    const answer = await ctx.board().request("couldn't edit " + ref(id), 'POST', '/messages/' + encodeURIComponent(id) + '/edit', { body: { text, ...(revision ? { revision } : {}) } })
    if (ctx.json) return ctx.emit({ edited: id, ...(answer.mentions ? { mentions: answer.mentions } : {}) })
    ctx.print(['edited ' + ref(id), ...mentionNotes(answer.mentions)])
  },
}

export const del = {
  usage: 'boards delete <id> [--revision <n>]\n\nDelete a message you wrote. It stays as a tombstone.',
  flags: { revision: 'string' },
  async run(ctx) {
    const id = idOf(required(ctx.positionals[0], 'a message ID', 'boards delete'))
    const revision = count(ctx.flags.revision, '--revision')
    await ctx.board().request("couldn't delete " + ref(id), 'POST', '/messages/' + encodeURIComponent(id) + '/delete', { body: revision ? { revision } : {} })
    if (ctx.json) return ctx.emit({ deleted: id })
    ctx.print(['deleted ' + ref(id)])
  },
}

/** A short name as the board takes it: eyes, :eyes:, or Thumbs_Up all read as their name. */
function emojiOf(input) {
  const found = /^:?([a-z0-9_+-]+):?$/i.exec(String(input).trim())
  if (!found) throw misuse('invalid_emoji', 'unknown emoji: ' + input + ' (use a short name like eyes or thumbs_up)')
  return found[1].toLowerCase()
}

export const react = {
  usage: 'boards react <id> <emoji> [--remove]\n\nReact with a short name, like eyes or thumbs_up. --remove takes yours back.',
  flags: { remove: 'bool' },
  async run(ctx) {
    const id = idOf(required(ctx.positionals[0], 'a message ID', 'boards react'))
    const emoji = emojiOf(required(ctx.positionals[1], 'an emoji', 'boards react'))
    const remove = Boolean(ctx.flags.remove)
    await ctx.board().request("couldn't react to " + ref(id), 'POST', '/messages/' + encodeURIComponent(id) + '/reactions', { body: { emoji, ...(remove ? { remove } : {}) } })
    if (ctx.json) return ctx.emit({ reaction: { id, emoji, removed: remove } })
    ctx.print([remove ? 'removed ' + emoji + ' from ' + ref(id) : 'reacted ' + emoji + ' to ' + ref(id)])
  },
}

/** Follows, or unfollows, what a message is in: its thread, or its discussion on a doc. */
async function setFollow(ctx, on, command) {
  const id = idOf(required(ctx.positionals[0], 'a message ID', 'boards ' + command))
  const answer = await ctx.board().request("couldn't " + command + ' ' + ref(id), 'POST', '/messages/' + encodeURIComponent(id) + '/follow', { body: { on } })
  if (ctx.json) return ctx.emit({ follow: answer })
  const what = answer.discussion ? 'the discussion ' + ref(answer.discussion) + ' in ' + ref(answer.thread) : ref(answer.thread)
  ctx.print([(on ? 'following ' : 'unfollowed ') + what])
}

export const follow = {
  usage: [
    'boards follow <id>',
    '',
    'Follow what a message is in: its thread, or on a doc, its discussion. What',
    'lands there then reaches you (boards tail --for me). Starting a thread follows',
    'it; replying, or being mentioned, follows it too.',
  ].join('\n'),
  flags: {},
  run: (ctx) => setFollow(ctx, true, 'follow'),
}

export const unfollow = {
  usage: 'boards unfollow <id>\n\nStop following what a message is in. A mention still reaches you.',
  flags: {},
  run: (ctx) => setFollow(ctx, false, 'unfollow'),
}

export const follows = {
  usage: 'boards follows [--limit <n>]\n\nWhat you follow, newest first: each thread, or discussion on a doc.',
  flags: { limit: 'string' },
  async run(ctx) {
    const limit = ctx.flags.limit ? Number(ctx.flags.limit) : undefined
    const answer = await ctx.board().request("couldn't list what you follow", 'GET', '/follows' + (limit ? '?limit=' + limit : ''))
    if (ctx.json) return ctx.emit({ follows: answer.follows })
    if (!answer.follows.length) return ctx.print(['following nothing'])
    ctx.print(columns(answer.follows.map((entry) => [ref(entry.thread) + (entry.discussion ? ' ' + ref(entry.discussion) : ''), entry.channel, entry.cause])))
  },
}

export const label = {
  usage: [
    'boards label <id> [k=v]... [--unset <k>]... [--if k=v]... [--if-unset <k>]...',
    '',
    'Set and unset labels on a message. --if and --if-unset make the write land only',
    'while those labels hold.',
  ].join('\n'),
  flags: { unset: 'list', if: 'list', 'if-unset': 'list' },
  async run(ctx) {
    const id = idOf(required(ctx.positionals[0], 'a message ID', 'boards label'))
    const set = pairs(ctx.positionals.slice(1), 'boards label')
    const unset = ctx.flags.unset ?? []
    if (!Object.keys(set).length && !unset.length) throw misuse('nothing_to_change', 'boards label needs k=v to set or --unset <k>', [['boards', 'label', '--help']])
    const conditions = { ...pairs(ctx.flags.if, '--if'), ...Object.fromEntries((ctx.flags['if-unset'] ?? []).map((key) => [key, null])) }
    await ctx.board().request("couldn't label " + ref(id), 'POST', '/messages/' + encodeURIComponent(id) + '/labels', {
      body: { ...(Object.keys(set).length ? { set } : {}), ...(unset.length ? { unset } : {}), ...(Object.keys(conditions).length ? { if: conditions } : {}) },
    })
    if (ctx.json) return ctx.emit({ labeled: { id, set, unset } })
    const said = [labelText(set), unset.length ? 'unset ' + unset.join(', ') : ''].filter(Boolean).join('  ')
    ctx.print(['labeled ' + ref(id) + '  ' + said])
  },
}

export const typing = {
  usage: 'boards typing <id> [status]\n\nShow typing in the platform threads that thread is synced to.',
  flags: {},
  async run(ctx) {
    const id = idOf(required(ctx.positionals[0], 'a message ID', 'boards typing'))
    const status = ctx.positionals.slice(1).join(' ').trim()
    const answer = await ctx.board().request("couldn't show typing for " + ref(id), 'POST', '/messages/' + encodeURIComponent(id) + '/typing', { body: status ? { status } : {} })
    if (ctx.json) return ctx.emit({ targets: answer.targets ?? [] })
    const targets = answer.targets ?? []
    ctx.print(targets.length ? targets.map((target) => 'typing in ' + target) : ['no synced thread shows typing for ' + ref(id)])
  },
}

// Messages the board sends later, once or on repeat.
import { count, pairs } from '../args.mjs'
import { channelOf, idOf, looksLikeId, mentionNotes, required, textOf } from '../common.mjs'
import { misuse } from '../failure.mjs'
import { fitted, oneLine, ref, span, when } from '../format.mjs'
import { uploadFile } from './files.mjs'

const DURATION = /^\d+(\.\d+)?(s|m|h|d)$/

function durationFlag(ctx, name) {
  const value = ctx.flags[name]
  if (value === undefined) return undefined
  if (!DURATION.test(value)) throw misuse('invalid_duration', '--' + name + ' is a duration like 30s, 30m, 12h, or 1d, not ' + value)
  return value
}

function instantFlag(ctx, name) {
  const value = ctx.flags[name]
  if (value === undefined) return undefined
  const time = Date.parse(value)
  if (Number.isNaN(time)) throw misuse('invalid_time', '--' + name + ' is a time like 2026-11-20T09:00:00Z or 2026-11-20T09:00+01:00, not ' + value)
  return new Date(time).toISOString()
}

const cancel = {
  usage: 'wb schedule cancel <id>\n\nCancel a schedule, so it sends nothing more.',
  flags: {},
  async run(ctx) {
    const id = required(ctx.positionals[0], 'a schedule ID', 'wb schedule cancel')
    const answer = await ctx.board().request("couldn't cancel schedule " + id, 'POST', '/schedules/' + encodeURIComponent(id) + '/cancel', { body: {} })
    if (ctx.json) return ctx.emit(answer)
    ctx.print([answer.canceled ? 'canceled ' + answer.schedule.id : answer.schedule.id + ' was ' + answer.schedule.state + ' already'])
  },
}

const create = {
  usage: [
    'wb schedule <channel>|<id> <text|-> (--in 30m | --at <time> | --every 1d)',
    '                [--until <time> | --for 7d | --times <n>] [--label k=v]...',
    '                [--attach <file>]...',
    '',
    'Post later. A channel starts a new thread each send; an ID replies in its',
    'thread. Durations look like 30s, 30m, 12h, or 1d; times like 2026-11-20T09:00Z.',
  ].join('\n'),
  flags: { in: 'string', at: 'string', every: 'string', until: 'string', for: 'string', times: 'string', label: 'list', attach: 'list' },
  async run(ctx) {
    const target = required(ctx.positionals[0], 'a channel or a message ID', 'wb schedule')
    const where = looksLikeId(target) ? { re: idOf(target) } : { channel: channelOf(target, 'schedule') }
    const timing = {
      in: durationFlag(ctx, 'in'),
      at: instantFlag(ctx, 'at'),
      every: durationFlag(ctx, 'every'),
      until: instantFlag(ctx, 'until'),
      for: durationFlag(ctx, 'for'),
      times: count(ctx.flags.times, '--times'),
    }
    if (!timing.in && !timing.at && !timing.every) throw misuse('missing_time', 'say when: --in, --at, or --every', [['wb', 'schedule', '--help']])
    if (timing.in && timing.at) throw misuse('invalid_flag', '--in and --at contradict each other')
    if ([timing.until, timing.for, timing.times].filter((v) => v !== undefined).length > 1) throw misuse('invalid_flag', 'pick one stop: --until, --for, or --times')
    if ((timing.until || timing.for || timing.times) && !timing.every) throw misuse('invalid_flag', '--until, --for, and --times stop a repeat: add --every')
    const attachments = []
    for (const file of ctx.flags.attach ?? []) attachments.push((await uploadFile(ctx, file)).id)
    const words = ctx.positionals.slice(1)
    const text = words.length === 0 && attachments.length ? '' : await textOf(ctx, words, 'text', 'wb schedule')
    const labels = pairs(ctx.flags.label, '--label')
    const body = { ...where, text, ...Object.fromEntries(Object.entries(timing).filter(([, v]) => v !== undefined)), ...(Object.keys(labels).length ? { labels } : {}), ...(attachments.length ? { attachments } : {}) }
    const answer = await ctx.board().request("couldn't schedule a message " + (where.re ? 'in ' + ref(where.re) : 'in ' + where.channel), 'POST', '/schedules', { body })
    if (ctx.json) return ctx.emit(answer)
    const s = answer.schedule
    ctx.print(['scheduled ' + s.id + ' in ' + (s.re ? ref(s.re) : s.channel) + '  ' + (s.every ? 'every ' + span(s.every) + ', ' : '') + 'next ' + when(s.next ?? s.first), ...mentionNotes(answer.mentions)])
  },
}

export const schedule = {
  usage: create.usage + '\n\n' + cancel.usage.split('\n')[0],
  pick(positionals) {
    const words = positionals.filter((arg) => !arg.startsWith('-'))
    const timed = positionals.some((arg) => /^--(in|at|every)(=|$)/.test(arg))
    // "schedule cancel <id>" cancels; so does "schedule cancel --help" ask for cancel's help. A schedule's text is never just "cancel".
    if (positionals[0] === 'cancel' && words.length <= 2 && !timed) return { command: cancel, name: 'schedule cancel', rest: 1 }
    return { command: create, name: 'schedule', rest: 0 }
  },
}

export const schedules = {
  usage: 'wb schedules [--channel <c>] [--re <id>] [--by <who>] [--all]\n\nPending schedules (--all: done and canceled ones too), oldest first.',
  flags: { channel: 'string', re: 'string', by: 'string', all: 'bool' },
  async run(ctx) {
    const answer = await ctx.board().request("couldn't list schedules", 'GET', '/schedules', {
      query: { channel: ctx.flags.channel, re: ctx.flags.re && idOf(ctx.flags.re), by: ctx.flags.by?.replace(/^@/, ''), all: ctx.flags.all ? 'true' : undefined },
    })
    if (ctx.json) return ctx.emit({ schedules: answer.schedules })
    if (!answer.schedules.length) return ctx.print([ctx.flags.all ? 'no schedules' : 'no pending schedules'])
    ctx.print(
      fitted(
        answer.schedules.map((s) => [
          s.id,
          s.state,
          s.re ? ref(s.re) : s.channel,
          s.every ? 'every ' + span(s.every) : 'once',
          s.next ? 'next ' + when(s.next) : 'sent ' + s.sent,
          oneLine(s.text) || '(files)',
        ]),
      ),
    )
  },
}

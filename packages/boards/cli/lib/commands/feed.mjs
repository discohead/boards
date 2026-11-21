// Following the board: tail streams events as they land; wait returns the first that matches.
import { count, duration } from '../args.mjs'
import { boardFailure, unreachable } from '../board.mjs'
import { channelOf, idOf, looksLikeId } from '../common.mjs'
import { Failure, misuse } from '../failure.mjs'
import { eventLine, span } from '../format.mjs'

const FILTER_FLAGS = { label: 'list', by: 'string', mentions: 'string', for: 'string', roots: 'bool', source: 'string', text: 'string', re: 'string', all: 'bool', after: 'string' }

/** The feed's query from a command's channel-or-ID and its filter flags. */
function filters(ctx, command) {
  const query = {}
  const target = ctx.positionals[0]
  if (ctx.positionals.length > 1) throw misuse('extra_argument', 'boards ' + command + ' takes one channel, prefix, or ID', [['boards', command, '--help']])
  if (target !== undefined) {
    if (looksLikeId(target)) query.re = idOf(target)
    else query.channel = channelOf(target, command, { subtree: true })
  }
  if (ctx.flags.re) query.re = idOf(ctx.flags.re)
  if (ctx.flags.label) query.label = ctx.flags.label
  if (ctx.flags.by) query.by = ctx.flags.by.replace(/^@/, '')
  if (ctx.flags.mentions) query.mentions = ctx.flags.mentions.replace(/^@/, '')
  if (ctx.flags.for) query.for = ctx.flags.for.replace(/^@/, '')
  if (ctx.flags.roots) query.roots = 'true'
  if (ctx.flags.source) query.from = ctx.flags.source
  if (ctx.flags.text) query.text = ctx.flags.text
  if (ctx.flags.all) query.all = 'true'
  return query
}

const backoff = (failures) => Math.min(30_000, 500 * 2 ** failures)

/** A failure worth trying again: no answer, or the board's own trouble. */
const passing = (error) => error instanceof Failure && (error.reason === 'unreachable' || (error.board && (error.board.status >= 500 || error.board.status === 429) && error.board.status !== 501))

/** Server-sent events from a response body: { id, event, data } per frame; comments skipped. */
async function* frames(body) {
  const decoder = new TextDecoder()
  let buffer = ''
  for await (const chunk of body) {
    buffer += decoder.decode(chunk, { stream: true }).replace(/\r\n?/g, '\n')
    let end
    while ((end = buffer.indexOf('\n\n')) !== -1) {
      const block = buffer.slice(0, end)
      buffer = buffer.slice(end + 2)
      const frame = { id: null, event: null, data: null }
      for (const line of block.split('\n')) {
        if (line === '' || line.startsWith(':')) continue
        const colon = line.indexOf(':')
        const field = colon === -1 ? line : line.slice(0, colon)
        const value = colon === -1 ? '' : line.slice(colon + 1).replace(/^ /, '')
        if (field === 'id') frame.id = value
        else if (field === 'event') frame.event = value
        else if (field === 'data') frame.data = frame.data === null ? value : frame.data + '\n' + value
      }
      if (frame.id !== null || frame.data !== null) yield frame
    }
  }
}

export const tail = {
  usage: [
    'boards tail [<channel>|<prefix/>|<id>] [--re <id>] [--label k=v]... [--by <who>]',
    '            [--mentions <who>] [--for <who>] [--roots] [--source <key>]',
    '            [--text <words>] [--all] [--last <n>] [--after <cursor>] [--json]',
    '',
    'Print events as they land, one line each (with --json, one JSON object a',
    'line), until Ctrl-C. --last starts with the newest n; --all shows bookkeeping',
    'events too. --for me is what reaches you: what mentions you, and what is in',
    'a thread or doc discussion you follow, not your own writes. --roots is new',
    'threads only.',
  ].join('\n'),
  flags: { ...FILTER_FLAGS, last: 'string' },
  async run(ctx) {
    const query = filters(ctx, 'tail')
    const last = count(ctx.flags.last, '--last')
    if (last && ctx.flags.after) throw misuse('invalid_flag', '--last reads the newest events: it takes no --after', [['boards', 'tail', '--help']])
    if (last > 100) throw misuse('invalid_number', '--last is at most 100')
    const board = ctx.board()
    ctx.interruptible()
    let cursor = ctx.flags.after ? idOf(ctx.flags.after) : null
    let first = true
    let failures = 0
    for (;;) {
      const asked = { ...query, ...(first && last ? { last } : {}) }
      try {
        let response
        try {
          response = await fetch(board.href('/events', asked), { headers: board.headers({ accept: 'text/event-stream', ...(cursor ? { 'last-event-id': cursor } : {}) }) })
        } catch (error) {
          throw unreachable("couldn't follow the board", board.url, error)
        }
        if (!response.ok) throw await boardFailure("couldn't follow the board", 'GET', '/events', response)
        first = false
        for await (const frame of frames(response.body)) {
          if (frame.id || frame.data) failures = 0
          if (frame.id) cursor = frame.id
          if (frame.event !== 'board' || frame.data === null) continue
          let event
          try {
            event = JSON.parse(frame.data)
          } catch {
            continue
          }
          ctx.print([ctx.json ? JSON.stringify(event) : eventLine(event)])
        }
      } catch (error) {
        // A stream the network cut reads as a TypeError (terminated, socket closed): reconnect.
        const cut = error instanceof TypeError && /terminated|fetch failed|socket|network|closed/i.test(error.message)
        if (!passing(error) && !cut) throw error
        failures++
        await new Promise((resolve) => setTimeout(resolve, backoff(failures)))
        continue
      }
      // The board closed the stream: go on from the cursor, at once unless it keeps closing on us.
      if (failures > 0) await new Promise((resolve) => setTimeout(resolve, backoff(failures)))
      failures++
    }
  },
}

export const wait = {
  usage: [
    'boards wait [<channel>|<prefix/>|<id>] [--re <id>] [--label k=v]... [--by <who>]',
    '            [--mentions <who>] [--for <who>] [--roots] [--source <key>]',
    '            [--text <words>] [--after <cursor>] [--timeout 30m]',
    '',
    'Wait for the first event that matches and print it. Exits 1 when the timeout',
    'passes with none. Without --after it waits for what lands from now on.',
  ].join('\n'),
  flags: { ...FILTER_FLAGS, timeout: 'string' },
  async run(ctx) {
    const query = filters(ctx, 'wait')
    const timeout = duration(ctx.flags.timeout ?? '30m', '--timeout')
    const board = ctx.board()
    ctx.interruptible()
    const deadline = Date.now() + timeout
    let after = ctx.flags.after ? idOf(ctx.flags.after) : null
    let failures = 0
    for (;;) {
      const left = Math.max(0, (deadline - Date.now()) / 1000)
      // Without a cursor the first ask finds the feed's end at once; then each ask holds up to 25 s.
      const waitFor = after === null ? 0 : Math.min(25, Math.ceil(left * 10) / 10)
      let page
      try {
        page = await board.request("couldn't wait on the board", 'GET', '/events', { query: { ...query, ...(after !== null ? { after } : {}), wait: waitFor } })
        failures = 0
      } catch (error) {
        if (!passing(error)) throw error
        failures++
        if (Date.now() + backoff(failures) >= deadline) throw timedOut(timeout)
        await new Promise((resolve) => setTimeout(resolve, backoff(failures)))
        continue
      }
      if (page.events?.length) {
        const event = page.events[0]
        if (ctx.json) return ctx.emit({ event, cursor: event.cursor })
        return ctx.print([eventLine(event)])
      }
      after = page.cursor ?? after
      if (Date.now() >= deadline - 20) throw timedOut(timeout)
    }
  },
}

const timedOut = (timeout) => new Failure({ reason: 'timeout', headline: 'nothing matched in ' + span(timeout) })

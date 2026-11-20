// How things read at a terminal: plain lines, columns padded so values line up, 80 columns.
export const WIDTH = 80

/** Rows of cells, each column padded to its widest cell, two spaces apart; the last cell runs free. */
export function columns(rows, indent = '') {
  const widths = []
  for (const row of rows) row.slice(0, -1).forEach((cell, i) => (widths[i] = Math.max(widths[i] ?? 0, String(cell).length)))
  return rows.map((row) => indent + row.map((cell, i) => (i < row.length - 1 ? String(cell).padEnd(widths[i]) : String(cell))).join('  ').trimEnd())
}

/** Rows whose last cell is cut to fit the width. */
export function fitted(rows, indent = '') {
  return columns(rows, indent).map((line) => fit(line))
}

export function fit(line, width = WIDTH) {
  return line.length <= width ? line : line.slice(0, width - 3).trimEnd() + '...'
}

export const oneLine = (text) => String(text ?? '').replace(/\s+/g, ' ').trim()

const pad2 = (n) => String(n).padStart(2, '0')

/** 2026-11-20 08:13, in local time. */
export function when(iso) {
  if (!iso) return '-'
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return String(iso)
  return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate()) + ' ' + pad2(d.getHours()) + ':' + pad2(d.getMinutes())
}

/** 08:13:46, in local time. */
export function clock(iso) {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return '--:--:--'
  return pad2(d.getHours()) + ':' + pad2(d.getMinutes()) + ':' + pad2(d.getSeconds())
}

/** 90000 as 1m30s, 3600000 as 1h. */
export function span(ms) {
  if (ms === null || ms === undefined) return '-'
  const parts = []
  let left = Math.round(ms / 1000)
  for (const [unit, size] of [['d', 86400], ['h', 3600], ['m', 60], ['s', 1]]) {
    if (left >= size) {
      parts.push(Math.floor(left / size) + unit)
      left %= size
    }
  }
  return parts.join('') || '0s'
}

export function bytes(n) {
  if (n < 1024) return n + ' B'
  if (n < 1024 * 1024) return (n / 1024).toFixed(1) + ' KB'
  return (n / 1024 / 1024).toFixed(1) + ' MB'
}

export const ref = (id) => '#' + id

/** Who wrote a message: its author's handle, or its actor ID. */
export const who = (message) => message?.author?.handle ?? message?.by?.actor ?? '-'

export const labelText = (labels) =>
  Object.entries(labels ?? {})
    .map(([key, value]) => (value === '' ? key : key + '=' + value))
    .join(', ')

/** A message: a heading line, then its text and details indented two spaces. */
export function messageBlock(message) {
  const head = [ref(message.id), who(message), when(message.createdAt)]
  if (message.deleted) head.push('deleted')
  else if (message.editedAt) head.push('edited')
  if (message.schedule) head.push('sent by ' + message.schedule.id)
  const lines = [head.join('  ')]
  if (!message.deleted) for (const line of String(message.text ?? '').split('\n')) lines.push(('  ' + line).trimEnd())
  const details = []
  if (message.task) details.push(['task', taskState(message.task)])
  const labels = Object.fromEntries(Object.entries(message.labels ?? {}).filter(([key]) => key !== 'board.task'))
  if (Object.keys(labels).length) details.push(['labels', labelText(labels)])
  const reactions = Object.entries(message.reactions ?? {}).map(([emoji, actors]) => emoji + ' ' + actors.length)
  if (reactions.length) details.push(['reactions', reactions.join(', ')])
  for (const file of message.attachments ?? []) details.push(['file', file.name + '  ' + file.id + '  ' + bytes(file.size)])
  for (const link of message.links ?? []) details.push(['link', link.url])
  for (const [target, error] of Object.entries(message.undelivered ?? {})) details.push(['undelivered', target + '  ' + oneLine(error)])
  if (details.length) lines.push(...columns(details, '  '))
  return lines
}

/** A task's state in words: ready, claimed by x until 08:40, waits for #3, #4. */
export function taskState(task) {
  if (!task) return '-'
  if (task.state === 'claimed' && task.claim) {
    const over = Date.parse(task.claim.until) <= Date.now()
    return 'claimed by ' + task.claim.actor + (over ? ', lease over' : ' until ' + when(task.claim.until))
  }
  if (task.state === 'waiting' && task.needs?.length) return 'waiting for ' + task.needs.map(ref).join(', ')
  if (task.state === 'blocked' && task.blocked) return 'blocked: ' + oneLine(task.blocked.reason)
  if (task.state === 'failed' && task.reason) return 'failed: ' + oneLine(task.reason)
  if (task.state === 'canceled' && task.reason) return 'canceled: ' + oneLine(task.reason)
  if (task.state === 'completed' && task.result) return 'completed: ' + oneLine(task.result)
  return task.state
}

/** What an event says beyond its type and message, in a few words. */
function eventDetail(event) {
  const p = event.payload ?? {}
  const m = event.message
  switch (event.type) {
    case 'message.posted':
      return (p.re ? 're ' + ref(p.re) + '  ' : '') + oneLine(p.text ?? m?.text ?? '') + ((p.attachments ?? []).length ? '  [' + p.attachments.length + ' file' + (p.attachments.length === 1 ? '' : 's') + ']' : '')
    case 'message.edited':
      return oneLine(p.text)
    case 'reaction.added':
    case 'reaction.removed':
      return p.emoji
    case 'labels.changed':
      return [labelText(p.set), ...(p.unset ?? []).map((key) => '-' + key)].filter(Boolean).join(', ')
    case 'channel.created':
      return p.channel
    case 'thread.synced':
      return p.target
    case 'message.sync_failed':
      return p.target + '  ' + oneLine(p.error)
    case 'task.created':
      return p.needs?.length ? 'needs ' + p.needs.map(ref).join(', ') : ''
    case 'task.claimed':
    case 'task.renewed':
      return 'until ' + when(p.until)
    case 'task.completed':
      return oneLine(p.result ?? '')
    case 'task.failed':
    case 'task.blocked':
    case 'task.canceled':
      return oneLine(p.reason ?? '')
    case 'task.assigned':
      return p.for ?? 'anyone'
    case 'task.needs_changed':
      return p.needs?.length ? p.needs.map(ref).join(', ') : 'nothing'
    default:
      return ''
  }
}

/** One event as one line: time, type, message, channel, who, and what it says. */
export function eventLine(event) {
  const m = event.message
  const id = m?.id ?? event.payload?.id
  const cells = [clock(event.createdAt), event.type, id ? ref(id) : '-', m?.channel ?? event.payload?.channel ?? '-', event.actor?.handle ?? event.payload?.by?.actor ?? '-']
  const detail = eventDetail(event)
  return fit(cells.join('  ') + (detail ? '  ' + detail : ''))
}

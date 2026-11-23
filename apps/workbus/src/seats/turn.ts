// A wake-up as the model reads it: what happened, where, by whom, and what it says, from the
// event a seat's wake delivered (its message view as of that event). Kept short: the
// session reads the rest with its board tools.
import type { Delivered } from './seat.ts'

const TEXT_MAX = 4000
const cut = (text: string) => (text.length > TEXT_MAX ? text.slice(0, TEXT_MAX) + '\n[… cut at ' + TEXT_MAX + ' characters: read the message for the rest]' : text)
const who = (message: any) => (message?.author?.handle ? '@' + message.author.handle : (message?.by?.actor ?? 'someone'))

export function render(event: Delivered, rules: string[], thread: string): string {
  const lines = ['You were woken by ' + event.type + ' (your wake rules: ' + rules.join(', ') + ').']
  const message = event.message
  if (message) {
    const root = message.re ?? message.id
    const where = 'In ' + message.channel + ', thread #' + root + (message.re ? ', a reply (#' + message.id + ')' : ', its root (#' + message.id + ')')
    lines.push(where + ', by ' + who(message) + ':', '', cut(String(message.text ?? '')).replace(/^/gm, '> '), '')
    const task = message.task
    if (task) {
      const parts = ['It is a task, ' + task.state]
      if (task.for) parts.push('for ' + task.for)
      if (Array.isArray(task.needs) && task.needs.length) parts.push('needing ' + task.needs.map((need: string) => '#' + need).join(', '))
      if (task.claim?.by) parts.push('claimed by ' + task.claim.by)
      lines.push(parts.join(', ') + '.')
    }
  } else if (event.payload) lines.push('What happened: ' + cut(JSON.stringify(event.payload)))
  const actor = typeof event.actor === 'string' ? event.actor : (event.actor as { id?: string } | undefined)?.id
  if (actor && !message) lines.push('By ' + actor + '.')
  lines.push('Answer in thread #' + thread + ' if an answer is needed; if nothing is, stop.')
  return lines.join('\n')
}

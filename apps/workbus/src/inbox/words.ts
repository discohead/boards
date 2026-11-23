// What an inbox item IS, in plain words (design/workbus.md §6.1): an approval for a command, a hire
// to apply, a change to the org, a budget hold, a decision, a reply. With who it's from and the
// request it belongs to (org.request), so an item says what it asks before it's opened.
import type { InboxItem } from './items.ts'
import { describe } from '@/task/proposal'
import { askOf } from '@/thread/approval'
import { REQUEST_LABEL } from '@/requests/model'

export type Words = { what: string; who: string | null; request: string | null }

const firstLine = (text: string) => (text.split('\n').find((line) => line.trim()) ?? '').replace(/^#+\s*/, '').trim()

export function wordsOf(one: InboxItem, name: (actor: string) => string, seatName: (handle: string) => string | null): Words {
  const task = one.task
  const root = one.root
  const request = task?.labels?.[REQUEST_LABEL] ?? root?.labels?.[REQUEST_LABEL] ?? null
  const who = task?.task.by ?? root?.by.actor ?? null
  for (const reason of one.reasons) {
    if (reason.kind === 'held') {
      if (reason.hold === 'approval') {
        const ask = askOf(reason.reason)
        return { what: ask ? 'An approval for a command: ' + (seatName(ask.handle) ?? '@' + ask.handle) + ' wants to run ' + ask.tool : 'An approval: ' + reason.reason, who, request }
      }
      if (reason.hold === 'budget') return { what: 'A budget hold: ' + firstLine(task?.text ?? reason.reason), who, request }
      if (reason.hold === 'decision') return { what: 'A decision for you: ' + (reason.reason || firstLine(task?.text ?? '')), who, request }
      if (reason.hold === 'review') return { what: 'A review for you: ' + (reason.reason || firstLine(task?.text ?? '')), who, request }
      if (reason.hold === 'edited') return { what: 'A task someone else edited, to look at before it goes on: ' + firstLine(task?.text ?? ''), who, request }
      return { what: 'Held for you: ' + (reason.reason || firstLine(task?.text ?? '')), who, request }
    }
    if (reason.kind === 'proposal' && task) {
      const proposal = describe(task)
      const kind = proposal?.kind
      const title = proposal?.title ?? firstLine(task.text)
      const what = kind === 'hire' ? 'A hire to apply: ' + title.replace(/^Creates the seat /, '') : kind === 'team' || kind === 'org' || kind === 'seat' ? 'A change to the org: ' + title : 'A proposed change: ' + title
      return { what, who, request }
    }
    if (reason.kind === 'reply') {
      const from = reason.latest?.by.actor ?? who
      return { what: (reason.mentions > 0 ? (from ? '@' + name(from) + ' mentioned you' : 'A mention') : from ? 'A reply from @' + name(from) : 'A reply') + ': ' + firstLine(reason.latest?.text ?? root?.text ?? ''), who: from, request }
    }
  }
  return { what: firstLine(root?.text ?? ''), who, request }
}

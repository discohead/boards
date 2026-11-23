// The page's bus (useBus), with the writes kept beside its own (src/data/docs-actions.ts and
// thread-actions.ts), each made once per bus.
import { useBus, type Bus } from '@/data'
import { docsActions, type DocsActions } from '@/data/docs-actions'
import { threadActions, type ThreadActions } from '@/data/shortcut-actions'

type More = { docActions: DocsActions; threadActions: ThreadActions }
const made = new WeakMap<Bus, More>()

export function withMore(bus: Bus): Bus & More {
  let more = made.get(bus)
  if (!more) made.set(bus, (more = { docActions: docsActions(bus), threadActions: threadActions(bus) }))
  return Object.assign(bus, more)
}

/** useBus(), with the doc and thread writes. */
export const useDocsBus = () => withMore(useBus())

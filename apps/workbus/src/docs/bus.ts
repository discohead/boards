// The page's bus (useBus), with the docs' writes kept beside its own (src/data/docs-actions.ts),
// made once per bus. The open thread's C and A use the task writes, bus.actions.task.
import { useBus, type Bus } from '@/data'
import { docsActions, type DocsActions } from '@/data/docs-actions'

type More = { docActions: DocsActions }
const made = new WeakMap<Bus, More>()

export function withMore(bus: Bus): Bus & More {
  let more = made.get(bus)
  if (!more) made.set(bus, (more = { docActions: docsActions(bus) }))
  return Object.assign(bus, more)
}

/** useBus(), with the doc writes. */
export const useDocsBus = () => withMore(useBus())

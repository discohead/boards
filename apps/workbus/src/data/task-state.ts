// A task's state as the app shows it (the design system's five), from the framework's seven. One
// place, so every view says the same thing: blocked is held (it waits on the principal), completed
// is done, a task whose needs aren't met is ready with what it waits on, and canceled is done with
// its own word.
import type { TaskFacet } from './types.ts'

export type ShownState = 'ready' | 'claimed' | 'held' | 'done' | 'failed'

export function taskState(task: Pick<TaskFacet, 'state' | 'needs'>): { state: ShownState; word: string; waitsOn?: string[] } {
  switch (task.state) {
    case 'blocked':
      return { state: 'held', word: 'held' }
    case 'completed':
      return { state: 'done', word: 'done' }
    case 'canceled':
      return { state: 'done', word: 'canceled' }
    case 'waiting':
      return { state: 'ready', word: 'waiting', waitsOn: task.needs }
    case 'claimed':
      return { state: 'claimed', word: 'claimed' }
    case 'failed':
      return { state: 'failed', word: 'failed' }
    default:
      return { state: 'ready', word: 'ready' }
  }
}

// The open thread's keyboard writes (design/workbus.md §9.3): make it a task (C), and assign that
// task (A), also what the pane's buttons call. Optimistic like the rest (actions.ts): each shows at
// once and settles when the feed brings the board's event for it back; a refusal rolls it back.
import { action, sendAndSettle } from './settle.ts'
import type { Bus } from './index.ts'
import type { Message } from './types.ts'

export function threadActions(bus: Bus) {
  const { db, runtime } = bus
  const { client } = runtime
  const feed = runtime.feed!
  const merge = (answer: { task: Message }) => bus.tasks.utils.rows.merge([answer.task], (row) => row.version)

  /** Make a thread that's there a task (POST /tasks { re }). */
  const makeTask = action<{ thread: string }>(db, {
    onMutate: ({ thread }) => {
      const root = bus.messages.get(thread) ?? bus.threads.get(thread)?.root
      if (!root || bus.tasks.has(thread)) return
      const me = runtime.me.actor
      const task = { state: 'ready', owner: me, by: me, for: null, needs: [], epoch: 0, claim: null, blocked: null, result: null, reason: null }
      bus.tasks.insert({ ...root, labels: { ...root.labels, 'board.task': 'ready' }, task, pending: thread })
      // The pane reads the root from messages: it shows the task at once too.
      if (bus.messages.has(thread))
        bus.messages.update(thread, (row) => {
          row.task = { ...task }
          row.labels['board.task'] = 'ready'
        })
    },
    mutationFn: async ({ thread }) => {
      await sendAndSettle(feed, () => client.post<{ task: Message }>('/tasks', { re: thread }), { test: (event) => event.message?.id === thread && event.message.task !== undefined }, merge)
    },
  })

  /** Assign a task to one of its owner's profiles, or to no one (POST /tasks/:id/assign { for }). */
  const assign = action<{ task: string; for: string | null }>(db, {
    onMutate: (input) => {
      if (!bus.tasks.has(input.task)) return
      bus.tasks.update(input.task, (row) => {
        if (row.task) row.task.for = input.for
      })
      if (bus.messages.get(input.task)?.task)
        bus.messages.update(input.task, (row) => {
          if (row.task) row.task.for = input.for
        })
    },
    mutationFn: async (input) => {
      await sendAndSettle(feed, () => client.post<{ task: Message }>('/tasks/' + input.task + '/assign', { for: input.for }), { test: (event) => event.message?.id === input.task && event.message.task?.for === input.for }, merge)
    },
  })

  return { makeTask, assign }
}

export type ThreadActions = ReturnType<typeof threadActions>

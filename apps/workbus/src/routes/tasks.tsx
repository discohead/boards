// Task lists (design/workbus.md §9.3): every task the principal can see, filtered, sorted, grouped
// by state or laid out as a board. A channel's queue is /tasks?channel=<path>; a team's,
// /tasks?channel=<team>/.
import { createFileRoute } from '@tanstack/react-router'
import { ListPane } from '@/shell/list-pane'
import { ListActions, stateChips, TaskList, useTaskRows } from '@/task/list'
import { useTasks } from '@/task/use-tasks'
import { useSetView, validateViewSearch, viewOf } from '@/task/view'

export const Route = createFileRoute('/tasks')({ validateSearch: validateViewSearch, component: Tasks })

function Tasks() {
  const search = Route.useSearch()
  const view = viewOf(search)
  const setView = useSetView()
  const rows = useTaskRows(useTasks())
  const queue = view.channel.length === 1 ? view.channel[0]! : null
  const title = queue ? (queue.endsWith('/') ? queue.slice(0, -1) + ' team' : '#' + queue) + ' queue' : 'Tasks'
  return (
    <ListPane title={title} chips={stateChips(rows, view, setView)} actions={<ListActions view={view} onView={setView} channel={queue && !queue.endsWith('/') ? queue : undefined} />}>
      <TaskList label={title} rows={rows} view={view} onView={setView} empty="No tasks yet. Make one from a message, or with ⌘K." />
    </ListPane>
  )
}
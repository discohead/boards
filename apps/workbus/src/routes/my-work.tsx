// My work: the tasks claimed by the principal, or assigned to it or one of its profiles, by state.
import { useMemo } from 'react'
import { createFileRoute } from '@tanstack/react-router'
import { ListPane } from '@/shell/list-pane'
import { TaskList, useTaskRows } from '@/task/list'
import { isMine } from '@/task/model'
import { useMe } from '@/task/me'
import { useTasks } from '@/task/use-tasks'
import { useSetView, validateViewSearch, viewOf } from '@/task/view'

export const Route = createFileRoute('/my-work')({ validateSearch: validateViewSearch, component: MyWork })

function MyWork() {
  const search = Route.useSearch()
  const view = viewOf(search)
  const setView = useSetView()
  const tasks = useTasks()
  const me = useMe()?.actor ?? ''
  const mine = useMemo(() => (me ? tasks.filter((task) => isMine(task, me)) : []), [tasks, me])
  const rows = useTaskRows(mine)
  return (
    <ListPane title="My work">
      <TaskList label="My work" rows={rows} view={view} onView={setView} empty="Nothing claimed by you or assigned to you." />
    </ListPane>
  )
}
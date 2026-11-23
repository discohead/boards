// Every task the principal can see, live, from the tasks collection.
import { useMemo } from 'react'
import { useLiveQuery } from '@tanstack/react-db'
import { useBus } from '@/data'
import { isTask, type Task } from './model.ts'

export function useTasks(): Task[] {
  const bus = useBus()
  const { data } = useLiveQuery({ query: (q) => q.from({ task: bus.tasks }) })
  return useMemo(() => data.filter((message) => isTask(message)) as Task[], [data])
}

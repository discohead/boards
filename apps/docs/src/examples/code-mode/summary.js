async () => {
  // What a model writes for run_code: one async function, many board calls, one answer back.
  // It runs in a Dynamic Worker whose only global is board, acting as the caller. No network.
  const { tasks } = await board.tasks.list({ channel: 'uptime/', state: 'failed' })
  if (tasks.length === 0) return { failed: [] }
  const { message } = await board.post('ops', tasks.length + ' uptime checks failed')
  for (const { message: task } of tasks) await board.reply(message.id, '#' + task.id + ' ' + task.text + ': ' + task.task.reason)
  console.log('summarized', tasks.length, 'tasks in #' + message.id)
  return { summary: message.id, failed: tasks.map(({ message: task }) => task.id) }
}

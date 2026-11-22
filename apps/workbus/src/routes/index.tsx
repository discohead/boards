// A placeholder shell: the sidebar's places, and who the app is on the bus, read through the
// WORKBUS binding in a server function. The views come in step 4 (design/workbus.md §9.3).
import { createFileRoute } from '@tanstack/react-router'
import { createServerFn } from '@tanstack/react-start'
import { Button } from '@/components/ui/button'
import { bus } from '@/bus'

const whoami = createServerFn().handler(async () => {
  try {
    return { ok: true as const, me: JSON.stringify(await bus().me(), null, 2) }
  } catch (error) {
    return { ok: false as const, error: (error as Error).message }
  }
})

export const Route = createFileRoute('/')({ loader: () => whoami(), component: Shell })

const PLACES = ['Inbox', 'My work', 'Channels', 'Docs']

function Shell() {
  const board = Route.useLoaderData()
  return (
    <div className="flex min-h-svh">
      <nav className="w-56 shrink-0 border-r bg-sidebar p-3 text-sm">
        <div className="mb-4 px-2 font-semibold">Workbus</div>
        {PLACES.map((place) => (
          <div key={place} className="rounded-md px-2 py-1.5 text-muted-foreground">
            {place}
          </div>
        ))}
      </nav>
      <main className="flex-1 p-8">
        <h1 className="text-xl font-semibold">The shell</h1>
        <p className="mt-2 max-w-prose text-muted-foreground">Channels, threads, tasks, docs, and the inbox land here next.</p>
        <pre data-testid="bus" className="mt-6 max-w-2xl overflow-auto rounded-md border bg-muted p-4 text-xs">
          {board.ok ? board.me : 'the bus: ' + board.error}
        </pre>
        <Button className="mt-6" onClick={() => location.reload()}>
          Reload
        </Button>
      </main>
    </div>
  )
}

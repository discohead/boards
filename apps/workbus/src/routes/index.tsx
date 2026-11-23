// A placeholder shell: the sidebar's places, and who the app is on the bus, read through the
// WORKBUS binding in a server function. The views come in step 4 (design/workbus.md §9.3).
import { createFileRoute } from '@tanstack/react-router'
import { createServerFn } from '@tanstack/react-start'
import { Button, Lockup, SidebarItem } from '@/components/system'
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
      <nav className="flex w-sidebar shrink-0 flex-col gap-px border-r border-line bg-sidebar p-2">
        <div className="px-2 pt-1 pb-3">
          <Lockup />
        </div>
        {PLACES.map((place) => (
          <SidebarItem key={place}>{place}</SidebarItem>
        ))}
      </nav>
      <main className="flex-1 p-8">
        <h1 className="text-title-xl text-text">The shell</h1>
        <p className="mt-2 max-w-prose text-doc text-body">Channels, threads, tasks, docs, and the inbox land here next.</p>
        <pre data-testid="bus" className="mt-6 max-w-2xl overflow-auto rounded-md border border-line bg-raised p-4 font-mono text-code">
          {board.ok ? board.me : 'the bus: ' + board.error}
        </pre>
        <Button variant="primary" className="mt-6" onClick={() => location.reload()}>
          Reload
        </Button>
      </main>
    </div>
  )
}

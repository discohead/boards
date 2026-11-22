// The root: the document, the first pages read on the server (as the person), and the app's frame:
// the sidebar, the main area, and the thread pane, whose open thread is ?thread=<id> on any route.
import { useMemo, type ReactNode } from 'react'
import type { DehydratedDbState } from '@tanstack/db'
import { HeadContent, Outlet, Scripts, createRootRoute } from '@tanstack/react-router'
import { firstPages } from '../first-pages.ts'
import { BusProvider } from '../db.tsx'
import { Sidebar } from '../shell/sidebar.tsx'
import { ThreadPane } from '../shell/thread-pane.tsx'
import { Keyboard } from '../command/Keyboard.tsx'
import css from '../styles.css?url'

/** ?thread=<id>: the open thread, a message ID (a number in the URL). */
export type RootSearch = { thread?: number }

export const Route = createRootRoute({
  validateSearch: (search: Record<string, unknown>): RootSearch => (/^[1-9]\d{0,15}$/.test(String(search.thread ?? '')) ? { thread: Number(search.thread) } : {}),
  // Read once, for the first paint; after that the browser's collections follow the feed.
  loader: async ({ location }) => {
    if (typeof window !== 'undefined') return null
    const channel = /^\/c\/(.+)$/.exec(location.pathname)?.[1]
    return await firstPages({ data: channel ? { channel: decodeURIComponent(channel) } : {} })
  },
  staleTime: Infinity,
  shouldReload: false,
  head: () => ({
    meta: [{ charSet: 'utf-8' }, { name: 'viewport', content: 'width=device-width, initial-scale=1' }, { title: 'Workbus' }],
    links: [{ rel: 'stylesheet', href: css }, { rel: 'icon', href: '/favicon.svg', type: 'image/svg+xml' }],
  }),
  shellComponent: Document,
  component: Frame,
})

function Document({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <head>
        <HeadContent />
      </head>
      <body className="bg-background text-foreground antialiased">
        {children}
        <Scripts />
      </body>
    </html>
  )
}

function Frame() {
  const first = Route.useLoaderData()
  const state = useMemo(() => (first?.state ? (JSON.parse(first.state) as DehydratedDbState) : null), [first?.state])
  return (
    <BusProvider state={state} token={first?.token ?? null}>
      <div className="flex h-svh overflow-hidden">
        <Sidebar />
        <main className="min-w-0 flex-1 overflow-y-auto">
          <Outlet />
        </main>
        <ThreadPane />
      </div>
      <Keyboard />
    </BusProvider>
  )
}

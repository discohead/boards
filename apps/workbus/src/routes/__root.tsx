// The root: the document, the first pages read on the server (as the person), and the app's frame:
// the sidebar, the main area, and the thread pane, whose open thread is ?thread=<id> on any route.
import { useMemo, type ReactNode } from 'react'
import type { DehydratedDbState } from '@tanstack/db'
import { HeadContent, Outlet, Scripts, createRootRoute, useLocation, useSearch } from '@tanstack/react-router'
import { firstPages } from '../first-pages.ts'
import { BusProvider } from '../db.tsx'
import { Sidebar } from '../shell/sidebar.tsx'
import { useInbox } from '../inbox/use-inbox.ts'
import { ThreadPane } from '../shell/thread-pane.tsx'
import { TopBar } from '../shell/top-bar.tsx'
import type { Me } from '../data/index.ts'
import { Keyboard } from '../command/Keyboard.tsx'
import { Toaster } from '@/components/ui/sonner'
import { appearanceScript } from '@/components/system/appearance'
import css from '../styles.css?url'

/** ?thread=<id>: the open thread, a message ID (a number in the URL); ?face=: its open tab. */
export type Face = 'conversation' | 'task' | 'doc'
export type RootSearch = { thread?: number; face?: Face }
const FACES: Face[] = ['conversation', 'task', 'doc']

export const Route = createRootRoute({
  validateSearch: (search: Record<string, unknown>): RootSearch => {
    if (!/^[1-9]\d{0,15}$/.test(String(search.thread ?? ''))) return {}
    return { thread: Number(search.thread), ...(FACES.includes(search.face as Face) ? { face: search.face as Face } : {}) }
  },
  // Read once, for the first paint; after that the browser's collections follow the feed.
  loader: async ({ location }) => {
    if (typeof window !== 'undefined') return null
    const channel = /^\/c\/(.+)$/.exec(location.pathname)?.[1]
    return await firstPages({ data: channel ? { channel: decodeURIComponent(channel) } : {} })
  },
  staleTime: Infinity,
  shouldReload: false,
  head: () => ({
    meta: [
      { charSet: 'utf-8' },
      { name: 'viewport', content: 'width=device-width, initial-scale=1' },
      { title: 'Workbus' },
    ],
    links: [
      { rel: 'preload', href: '/fonts/geist.woff2', as: 'font', type: 'font/woff2', crossOrigin: 'anonymous' },
      { rel: 'stylesheet', href: css },
      { rel: 'icon', href: '/favicon.svg', type: 'image/svg+xml' },
      { rel: 'apple-touch-icon', href: '/apple-touch-icon.png' },
    ],
  }),
  shellComponent: Document,
  component: Frame,
  errorComponent: ({ error }) => (
    <div role="alert" className="p-8 text-sm">
      <p className="font-medium">Something went wrong showing this page.</p>
      <p className="mt-1 font-mono text-muted-foreground">{error instanceof Error ? error.message : String(error)}</p>
    </div>
  ),
})

// data-theme and data-density are set before paint by the inline script, so React leaves them be.
function Document({ children }: { children: ReactNode }) {
  return (
    <html lang="en" data-theme="light" data-density="compact" suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: appearanceScript }} />
        <HeadContent />
      </head>
      <body>
        {children}
        <Toaster />
        <Scripts />
      </body>
    </html>
  )
}

function Frame() {
  const first = Route.useLoaderData()
  const state = useMemo(() => (first?.state ? (JSON.parse(first.state) as DehydratedDbState) : null), [first?.state])
  const me = useMemo(() => (first?.me ? (JSON.parse(first.me) as Me) : null), [first?.me])
  const pathname = useLocation({ select: (location) => location.pathname })
  const threadOpen = useSearch({ strict: false, select: (search: RootSearch) => search.thread !== undefined })
  // The dev gallery (/dev/system) draws its own screens, outside the frame.
  if (pathname.startsWith('/dev/'))
    return (
      <BusProvider state={state} me={me} token={first?.token ?? null}>
        <Outlet />
      </BusProvider>
    )
  return (
    <BusProvider state={state} me={me} token={first?.token ?? null}>
      <div className="flex h-svh overflow-hidden">
        <InboxSidebar />
        <main className="flex min-w-0 flex-1 flex-col">
          <TopBar title={titleOf(pathname)} />
          <div data-testid="workspace" className="flex min-h-0 flex-1">
            {/* The view's list: the whole width alone, the list's width beside an open thread. */}
            <div className={threadOpen ? 'flex w-[344px] shrink-0 flex-col overflow-hidden border-r border-line' : 'flex min-w-0 flex-1 flex-col'}>
              <Outlet />
            </div>
            <ThreadPane />
          </div>
        </main>
      </div>
      <Keyboard />
    </BusProvider>
  )
}

/** The top bar's view title, by route. */
function titleOf(pathname: string): string {
  const channel = /^\/c\/(.+)$/.exec(pathname)?.[1]
  if (channel) return decodeURIComponent(channel)
  const first = pathname.split('/')[1] ?? ''
  return ({ '': 'Inbox', 'my-work': 'My work', tasks: 'Tasks', docs: 'Docs', settings: 'Settings' } as Record<string, string>)[first] ?? 'Workbus'
}

/** The sidebar, with the inbox's count: what's waiting on the principal. */
function InboxSidebar() {
  const { items } = useInbox()
  return <Sidebar inboxCount={items.length} />
}

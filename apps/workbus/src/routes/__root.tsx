import type { ReactNode } from 'react'
import { HeadContent, Scripts, createRootRoute } from '@tanstack/react-router'
import { Toaster } from '@/components/ui/sonner'
import { appearanceScript } from '@/components/system/appearance'
import css from '../styles.css?url'

export const Route = createRootRoute({
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

// The design system's gallery, in development only: every component in both themes and both
// densities (design/system/ has the system's own previews). A production build has no gallery: the
// route answers not found and its component isn't bundled.
import { createFileRoute, lazyRouteComponent, notFound } from '@tanstack/react-router'

type Search = { only?: string; theme?: 'light' | 'dark'; density?: 'compact' | 'comfortable' }

export const Route = createFileRoute('/dev/system')({
  validateSearch: (s: Record<string, unknown>): Search => ({
    only: typeof s.only === 'string' ? s.only : undefined,
    theme: s.theme === 'dark' || s.theme === 'light' ? s.theme : undefined,
    density: s.density === 'comfortable' || s.density === 'compact' ? s.density : undefined,
  }),
  beforeLoad: () => {
    if (!import.meta.env.DEV) throw notFound()
  },
  component: import.meta.env.DEV ? lazyRouteComponent(() => import('@/dev/gallery')) : () => null,
})

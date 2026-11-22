import { createFileRoute } from '@tanstack/react-router'

export const Route = createFileRoute('/docs/')({ component: () => <p className="p-8 text-muted-foreground">Pick a doc.</p> })

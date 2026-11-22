// The docs tree. A stub: ci's src/routes/docs* replace it.
import { createFileRoute } from '@tanstack/react-router'

export const Route = createFileRoute('/docs')({ component: Docs })

function Docs() {
  return (
    <div className="p-8">
      <h1 className="text-lg font-semibold">Docs</h1>
      <p className="mt-2 text-sm text-muted-foreground">Not built yet.</p>
    </div>
  )
}

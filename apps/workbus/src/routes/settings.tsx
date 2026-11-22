// Settings: org, access, sync, budgets. Later.
import { createFileRoute } from '@tanstack/react-router'

export const Route = createFileRoute('/settings')({ component: Settings })

function Settings() {
  return (
    <div className="p-8">
      <h1 className="text-lg font-semibold">Settings</h1>
      <p className="mt-2 text-sm text-muted-foreground">Not built yet.</p>
    </div>
  )
}

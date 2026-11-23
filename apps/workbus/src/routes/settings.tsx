// Settings: your display name now; org, access, sync, and budgets later.
import { useState } from 'react'
import { createFileRoute } from '@tanstack/react-router'
import { useBus, BusRefusal } from '@/data'
import { Button, Input } from '@/components/system'
import { ListPane } from '@/shell/list-pane'
import { useDisplayNames } from '@/shell/display-name'

export const Route = createFileRoute('/settings')({ component: Settings })

function Settings() {
  const bus = useBus()
  const me = bus.runtime.me
  const current = useDisplayNames()(me.actor, me.name ?? '')
  const [draft, setDraft] = useState<string | null>(null)
  const [state, setState] = useState<{ saving: boolean; error: string | null; saved: string | null }>({ saving: false, error: null, saved: null })
  const value = draft ?? current
  const save = () => {
    const name = value.trim()
    if (!name || name === current) return
    setState({ saving: true, error: null, saved: null })
    bus.actions.setName({ name }).when('settled').then(
      () => (setDraft(null), setState({ saving: false, error: null, saved: name })),
      (error: unknown) => setState({ saving: false, error: error instanceof BusRefusal ? error.message.replace(/^[a-z_]+: /, '') : String(error), saved: null }),
    )
  }
  return (
    <ListPane title="Settings" foot={false}>
      <form
        data-testid="settings-name"
        className="flex max-w-md flex-col gap-3 px-4 py-4"
        onSubmit={(event) => {
          event.preventDefault()
          save()
        }}
      >
        <Input id="display-name" label="Display name" value={value} hint={'How the board shows you, on every message. @' + (me.handle ?? '') + ' stays your handle.'} {...(state.error ? { error: state.error } : {})} onChange={(event) => setDraft(event.target.value)} />
        <div className="flex items-center gap-3">
          <Button type="submit" variant="primary" size="sm" disabled={state.saving || !value.trim() || value.trim() === current}>
            Save name
          </Button>
          <span data-testid="settings-name-state" className="font-mono text-mono-ui text-muted-foreground">
            {state.saving ? 'saving…' : state.saved ? 'Saved.' : ''}
          </span>
        </div>
      </form>
    </ListPane>
  )
}

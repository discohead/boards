// Settings: your display name; and for an owner, the board's people, where one may be hidden (#16).
import { useEffect, useState } from 'react'
import { createFileRoute } from '@tanstack/react-router'
import { useBus, BusRefusal } from '@/data'
import { Button, Input } from '@/components/system'
import { ListPane } from '@/shell/list-pane'
import { useDisplayNames } from '@/shell/display-name'
import { Avatar } from '@/components/system'
import { initialsFor } from '@/seats/initials'

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
      {me.can && Object.entries(me.can).some(([pattern, perms]) => pattern === '*' && (perms.includes('manage') || perms.includes('all'))) && !me.actor.includes('+') ? <People /> : null}
    </ListPane>
  )
}

type Person = { id: string; kind: string; handle: string; name: string; hidden?: { by: string; at: string } }

/**
 * The board's people, for an owner (manage at *): hide one that's no longer used (a test identity, a
 * let-go seat) and it leaves the lists and mention settling, its handle free; its messages keep their
 * author. Show it again here, or it comes back by writing.
 */
function People() {
  const bus = useBus()
  const [people, setPeople] = useState<Person[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const read = () => bus.runtime.client.get<{ actors: Person[] }>('/actors?hidden=true').then((answer) => setPeople(answer.actors), (failed: Error) => setError(failed.message))
  useEffect(() => void read(), [bus])
  const set = async (actor: string, hidden: boolean) => {
    setError(null)
    try {
      await bus.runtime.client.post('/actors/hide', { actor, hidden })
      await read()
    } catch (failed) {
      setError(failed instanceof Error ? failed.message : String(failed))
    }
  }
  return (
    <section aria-label="People" data-testid="settings-people" className="max-w-2xl px-4 py-4">
      <h2 className="mb-1 font-mono text-mono-label tracking-[0.07em] text-muted-foreground uppercase">People and seats on the board</h2>
      <p className="mb-3 text-[13px] text-muted-foreground">Hide one that's no longer used: it leaves the lists and @mentions, and its handle is free. Its messages keep their author. It comes back if it writes again.</p>
      {error ? <p role="alert" className="mb-2 text-[13px] text-danger">{error}</p> : null}
      {!people ? (
        <p className="text-[13px] text-muted-foreground">Reading…</p>
      ) : (
        <ul className="flex flex-col">
          {people.map((one) => (
            <li key={one.id} data-actor={one.id} data-hidden={one.hidden ? 'yes' : undefined} className="flex items-center gap-2 border-b border-line py-1.5 text-[13px]">
              <Avatar kind={one.kind === 'person' ? 'person' : 'agent'} initials={initialsFor(one.id, one.name, one.handle)} size="xs" />
              <span className={one.hidden ? 'text-muted-foreground line-through' : 'text-text'}>{one.name}</span>
              <span className="font-mono text-mono-ui text-muted-foreground">@{one.handle}</span>
              <span className="ml-auto">
                {one.id === bus.runtime.me.actor ? null : (
                  <Button size="sm" variant="ghost" onClick={() => void set(one.id, !one.hidden)}>
                    {one.hidden ? 'Show' : 'Hide'}
                  </Button>
                )}
              </span>
            </li>
          ))}
        </ul>
      )}
    </section>
  )
}

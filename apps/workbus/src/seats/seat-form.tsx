// A seat doc's config as a form (TanStack Form): name, handle, model, tools, can, wakes, sessions,
// budget, state, and approve. It writes the doc's json#seat@1 block as the principal, at the doc's
// revision it read, after checking the block against the schema the board checks it with; a field
// the schema refuses says why beside it, and the board's own refusal is shown as it gave it. Once
// saved, it follows the reconciler: applied when the Seat holds that revision, or its reply in the
// doc's thread when that revision can't apply. The charter prose is the doc editor's.
import { useEffect, useState } from 'react'
import { useForm } from '@tanstack/react-form'
import { X } from 'lucide-react'
import { Button } from '@/components/system'
import { useBus } from '@/data'
import { checkSeatBlock } from '@/org/schema-check'
import { refreshSeats } from './use-seats.ts'
import type { SeatView } from './views.ts'
import { blockIn, blockOf, fieldOf, KNOWN_TOOLS, PERMISSIONS, valuesOf, WAKE_KINDS, WAKE_VALUE, withBlock, type Block, type Permission, type SeatValues, type WakeKind } from './seat-config.ts'

type Page = { doc: { id: string; revision: string }; body: string }
type Saved = { revision: number; state: 'applying' | 'applied' | 'refused'; why?: string }

const input = 'h-7 w-full rounded-sm border border-line-strong bg-surface px-2 text-[13px] text-text aria-[invalid=true]:border-danger'
const label = 'mb-1 block font-mono text-mono-label tracking-[0.07em] text-muted-foreground uppercase'

export function SeatConfig({ seat, onClose }: { seat: SeatView; onClose: () => void }) {
  const bus = useBus()
  const [page, setPage] = useState<Page | null>(null)
  const [error, setError] = useState<string | null>(null)
  // What the last save did, kept here: a save re-reads the form from the doc it wrote.
  const [saved, setSaved] = useState<Saved | null>(null)

  // After a save: applied once the Seat holds that revision; the reconciler's reply if it can't apply it.
  useEffect(() => {
    if (!saved || saved.state !== 'applying' || !seat.doc) return
    if (seat.revision !== null && seat.revision >= saved.revision) return setSaved({ ...saved, state: 'applied' })
    const timer = setInterval(async () => {
      // The reconciler's reply in the doc's thread (org/reconcile.ts), after the edit it answers.
      const thread = await bus.runtime.client.get<{ replies: { id: string; text: string; by: { actor: string } }[] }>('/messages/' + seat.doc + '?limit=500').catch(() => null)
      const reply = thread?.replies.find((one) => Number(one.id) > saved.revision && one.by.actor === 'worker:workbus-app' && one.text.startsWith('This revision of'))
      if (reply) setSaved({ ...saved, state: 'refused', why: reply.text.replace(/^This revision of \S+ can't apply: /, '') })
    }, 2_000)
    return () => clearInterval(timer)
  }, [saved, seat.revision, seat.doc, bus])
  useEffect(() => {
    if (!seat.doc) return setError('This seat has no doc to edit.')
    bus.runtime.client.get<Page>('/docs/' + seat.doc).then(setPage, (failed: Error) => setError(failed.message))
  }, [bus, seat.doc])
  if (error) return <p role="alert" className="text-[13px] text-danger">{error}</p>
  if (!page) return <p className="text-[13px] text-muted-foreground">Reading its doc…</p>
  const block = blockIn(page.body)
  if (!block) return <p role="alert" className="text-[13px] text-danger">Its doc has no json#seat@1 block to edit: add one in the doc first.</p>
  return (
    <>
      <Form key={page.doc.revision} seat={seat} page={page} block={block} onClose={onClose} onSaved={(next, revision) => (setSaved({ revision, state: 'applying' }), setPage(next))} />
      {saved ? (
        <p data-testid="seat-saved" data-state={saved.state} className={'mt-2 text-[13px] ' + (saved.state === 'refused' ? 'text-danger' : 'text-body')}>
          {saved.state === 'applying' ? 'Saved as revision ' + saved.revision + '. The reconciler is applying it…' : saved.state === 'applied' ? 'Saved as revision ' + saved.revision + ', and applied: the seat runs with it.' : 'Saved as revision ' + saved.revision + ", but it can't apply: " + (saved.why ?? '')}
        </p>
      ) : null}
    </>
  )
}

function Form({ seat, page, block, onClose, onSaved }: { seat: SeatView; page: Page; block: Block; onClose: () => void; onSaved: (page: Page, revision: number) => void }) {
  const bus = useBus()
  const [refusal, setRefusal] = useState<string | null>(null)

  const form = useForm({
    defaultValues: valuesOf(block) as SeatValues,
    validators: {
      onSubmit: ({ value }) => {
        const fields: Record<string, string> = {}
        const form: string[] = []
        value.can.forEach((row, i) => {
          if (!row.pattern.trim()) fields['can[' + i + '].pattern'] = 'name a channel, a subtree (eng/), or *'
          else if (value.can.findIndex((other) => other.pattern.trim() === row.pattern.trim()) !== i) fields['can[' + i + '].pattern'] = 'this pattern is here twice'
        })
        value.wakes.forEach((row, i) => {
          if (WAKE_VALUE[row.kind] && !row.value.trim()) fields['wakes[' + i + '].value'] = 'name ' + WAKE_VALUE[row.kind]
        })
        value.approve.forEach((row, i) => {
          if (!row.tool.trim()) fields['approve[' + i + '].tool'] = 'name a tool'
        })
        for (const problem of checkSeatBlock(blockOf(value, block))) {
          const field = fieldOf(problem, value)
          if (field && !fields[field]) fields[field] = problem.message
          else if (!field) form.push(problem.path + ' ' + problem.message)
        }
        return Object.keys(fields).length || form.length ? { form: form.join('; ') || 'Fix the fields marked below.', fields } : undefined
      },
    },
    onSubmit: async ({ value }) => {
      setRefusal(null)
      const next = blockOf(value, block)
      const body = withBlock(page.body, next)
      try {
        const answer = await bus.runtime.client.post<{ doc: { revision: string } }>('/docs/' + page.doc.id + '/edit', { revision: page.doc.revision, body })
        onSaved({ doc: { id: page.doc.id, revision: answer.doc.revision }, body }, Number(answer.doc.revision))
        refreshSeats()
      } catch (failed) {
        setRefusal(failed instanceof Error ? failed.message : String(failed))
      }
    },
  })

  const err = (errors: unknown[]) => (errors.length ? <p className="mt-1 text-[12px] text-danger" role="alert">{errors.map(String).join('; ')}</p> : null)
  return (
    <form
      data-testid="seat-form"
      className="flex flex-col gap-4 rounded-md border border-line bg-sidebar p-4"
      onSubmit={(event) => {
        event.preventDefault()
        void form.handleSubmit()
      }}
    >
      <div className="grid gap-3 sm:grid-cols-3">
        {(['name', 'handle', 'model'] as const).map((name) => (
          <form.Field key={name} name={name}>
            {(field) => (
              <div>
                <label className={label} htmlFor={'seat-' + name}>
                  {name}
                </label>
                <input id={'seat-' + name} data-field={name} className={input} aria-invalid={field.state.meta.errors.length > 0} placeholder={name === 'handle' ? seat.key : name === 'model' ? 'anthropic/claude-haiku-5-5' : ''} value={field.state.value} onChange={(event) => field.handleChange(event.target.value)} />
                {err(field.state.meta.errors)}
              </div>
            )}
          </form.Field>
        ))}
      </div>

      <form.Field name="tools">
        {(field) => (
          <fieldset>
            <legend className={label}>Tools</legend>
            <div className="flex flex-wrap gap-3">
              {[...new Set([...KNOWN_TOOLS, ...field.state.value])].map((tool) => (
                <label key={tool} className="inline-flex items-center gap-1.5 font-mono text-mono-ui text-text">
                  <input type="checkbox" data-tool={tool} checked={field.state.value.includes(tool)} onChange={(event) => field.handleChange(event.target.checked ? [...field.state.value, tool] : field.state.value.filter((one) => one !== tool))} />
                  {tool}
                </label>
              ))}
            </div>
            {err(field.state.meta.errors)}
          </fieldset>
        )}
      </form.Field>

      <form.Field name="can" mode="array">
        {(field) => (
          <fieldset>
            <legend className={label}>Can</legend>
            {field.state.value.map((_, i) => (
              <div key={i} data-can-row={i} className="mb-2 flex flex-wrap items-start gap-2">
                <form.Field name={`can[${i}].pattern`}>
                  {(sub) => (
                    <div className="w-40">
                      <input aria-label="Pattern" data-field={'can-' + i} className={input + ' font-mono'} aria-invalid={sub.state.meta.errors.length > 0} value={sub.state.value} onChange={(event) => sub.handleChange(event.target.value)} />
                      {err(sub.state.meta.errors)}
                    </div>
                  )}
                </form.Field>
                <form.Field name={`can[${i}].all`}>
                  {(sub) => (
                    <label className="inline-flex h-7 items-center gap-1 font-mono text-mono-ui">
                      <input type="checkbox" checked={sub.state.value} onChange={(event) => sub.handleChange(event.target.checked)} />
                      all
                    </label>
                  )}
                </form.Field>
                <form.Subscribe selector={(state) => state.values.can[i]?.all}>
                  {(all) =>
                    all ? null : (
                      <form.Field name={`can[${i}].permissions`}>
                        {(sub) => (
                          <div className="flex h-7 flex-wrap items-center gap-2">
                            {PERMISSIONS.map((one) => (
                              <label key={one} className="inline-flex items-center gap-1 font-mono text-mono-label text-text">
                                <input type="checkbox" data-permission={one} checked={sub.state.value.includes(one)} onChange={(event) => sub.handleChange(event.target.checked ? [...sub.state.value, one as Permission] : sub.state.value.filter((p) => p !== one))} />
                                {one}
                              </label>
                            ))}
                          </div>
                        )}
                      </form.Field>
                    )
                  }
                </form.Subscribe>
                <button type="button" aria-label="Remove this pattern" className="ml-auto h-7 text-muted-foreground hover:text-text" onClick={() => field.removeValue(i)}>
                  <X size={14} />
                </button>
              </div>
            ))}
            <Button size="sm" variant="ghost" icon="plus" onClick={() => field.pushValue({ pattern: '', all: false, permissions: ['read'] })}>
              Add a pattern
            </Button>
            {err(field.state.meta.errors)}
          </fieldset>
        )}
      </form.Field>

      <form.Field name="wakes" mode="array">
        {(field) => (
          <fieldset>
            <legend className={label}>Wakes</legend>
            {field.state.value.map((_, i) => (
              <div key={i} data-wake-row={i} className="mb-2 flex items-start gap-2">
                <form.Field name={`wakes[${i}].kind`}>
                  {(sub) => (
                    <select aria-label="Wake rule" className={input.replace('w-full', 'w-40 shrink-0') + ' font-mono'} value={sub.state.value} onChange={(event) => sub.handleChange(event.target.value as WakeKind)}>
                      {WAKE_KINDS.map((kind) => (
                        <option key={kind} value={kind}>
                          {kind === 'dm-all' ? 'every DM message' : kind}
                        </option>
                      ))}
                    </select>
                  )}
                </form.Field>
                <form.Subscribe selector={(state) => state.values.wakes[i]?.kind}>
                  {(kind) =>
                    kind && WAKE_VALUE[kind] ? (
                      <form.Field name={`wakes[${i}].value`}>
                        {(sub) => (
                          <div className="flex-1">
                            <input aria-label="Its channel" data-field={'wake-' + i} className={input + ' font-mono'} placeholder={WAKE_VALUE[kind]} aria-invalid={sub.state.meta.errors.length > 0} value={sub.state.value} onChange={(event) => sub.handleChange(event.target.value)} />
                            {err(sub.state.meta.errors)}
                          </div>
                        )}
                      </form.Field>
                    ) : (
                      <span className="flex-1" />
                    )
                  }
                </form.Subscribe>
                <button type="button" aria-label="Remove this rule" className="h-7 text-muted-foreground hover:text-text" onClick={() => field.removeValue(i)}>
                  <X size={14} />
                </button>
              </div>
            ))}
            <Button size="sm" variant="ghost" icon="plus" onClick={() => field.pushValue({ kind: 'mention', value: '' })}>
              Add a rule
            </Button>
          </fieldset>
        )}
      </form.Field>

      <div className="grid gap-3 sm:grid-cols-4">
        {(['sessions', 'budgetMonth', 'budgetAlert'] as const).map((name) => (
          <form.Field key={name} name={name}>
            {(field) => (
              <div>
                <label className={label} htmlFor={'seat-' + name}>
                  {name === 'sessions' ? 'Sessions' : name === 'budgetMonth' ? 'Budget, $/month' : 'Alert at (0–1)'}
                </label>
                <input id={'seat-' + name} data-field={name} inputMode="decimal" className={input + ' font-mono'} aria-invalid={field.state.meta.errors.length > 0} value={field.state.value} onChange={(event) => field.handleChange(event.target.value)} />
                {err(field.state.meta.errors)}
              </div>
            )}
          </form.Field>
        ))}
        <form.Field name="state">
          {(field) => (
            <div>
              <label className={label} htmlFor="seat-state">
                State
              </label>
              <select id="seat-state" data-field="state" className={input} value={field.state.value} onChange={(event) => field.handleChange(event.target.value as 'active' | 'paused')}>
                <option value="active">active</option>
                <option value="paused">paused</option>
              </select>
            </div>
          )}
        </form.Field>
      </div>

      <form.Field name="approve" mode="array">
        {(field) => (
          <fieldset>
            <legend className={label}>Approve: tools held for you, and the kind of hold</legend>
            {field.state.value.map((_, i) => (
              <div key={i} data-approve-row={i} className="mb-2 flex items-start gap-2">
                {(['tool', 'kind'] as const).map((part) => (
                  <form.Field key={part} name={`approve[${i}].${part}`}>
                    {(sub) => (
                      <div className="w-40">
                        <input aria-label={part === 'tool' ? 'Tool' : 'Kind'} placeholder={part === 'tool' ? 'exec' : 'approval'} className={input + ' font-mono'} aria-invalid={sub.state.meta.errors.length > 0} value={sub.state.value} onChange={(event) => sub.handleChange(event.target.value)} />
                        {err(sub.state.meta.errors)}
                      </div>
                    )}
                  </form.Field>
                ))}
                <button type="button" aria-label="Remove this approval" className="h-7 text-muted-foreground hover:text-text" onClick={() => field.removeValue(i)}>
                  <X size={14} />
                </button>
              </div>
            ))}
            <Button size="sm" variant="ghost" icon="plus" onClick={() => field.pushValue({ tool: '', kind: 'approval' })}>
              Add an approval
            </Button>
          </fieldset>
        )}
      </form.Field>

      <form.Subscribe selector={(state) => [state.errorMap.onSubmit, state.isSubmitting, state.isDirty] as const}>
        {([formError, submitting, dirty]) => (
          <div className="flex flex-wrap items-center gap-2 border-t border-line pt-3">
            <Button type="submit" variant="primary" disabled={submitting || !dirty} data-testid="seat-save">
              {submitting ? 'Saving…' : 'Save config'}
            </Button>
            <Button variant="outline" onClick={onClose}>
              Close
            </Button>
            <span className="font-mono text-mono-label text-muted-foreground">writes org/seats/{seat.key}'s json#seat@1 block as you, at revision {page.doc.revision}</span>
            {formError ? (
              <p data-testid="seat-form-error" role="alert" className="basis-full text-[13px] text-danger">
                {typeof formError === 'string' ? formError : (formError as { form?: string }).form ?? 'Fix the fields marked above.'}
              </p>
            ) : null}
          </div>
        )}
      </form.Subscribe>
      {refusal ? (
        <p data-testid="seat-refusal" role="alert" className="text-[13px] text-danger">
          The board refused it: {refusal}
        </p>
      ) : null}
    </form>
  )
}


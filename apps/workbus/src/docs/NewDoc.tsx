// A new document: its folder (a channel), its name in it, and its first text. It lands when the board
// has it, and opens on its Document face.
import { useState } from 'react'
import { Button } from '@/components/system'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { useDocsBus } from './bus'

const slugOf = (title: string) => title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 128)

export function NewDoc({ open, onClose, onMade }: { open: boolean; onClose: () => void; onMade: (id: string) => void }) {
  const bus = useDocsBus()
  const [channel, setChannel] = useState('docs')
  const [title, setTitle] = useState('')
  const [text, setText] = useState('')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const make = async () => {
    const slug = slugOf(title)
    if (!slug) return setError('Give it a title.')
    setSaving(true)
    setError(null)
    try {
      const message = await bus.actions.createDoc({ channel: channel.trim(), slug, body: '# ' + title.trim() + '\n\n' + text.trim() + '\n' })
      setTitle('')
      setText('')
      onClose()
      onMade(message.id)
    } catch (failure) {
      setError((failure as Error).message)
    } finally {
      setSaving(false)
    }
  }
  return (
    <Dialog open={open} onOpenChange={(next) => !next && onClose()}>
      <DialogContent data-testid="new-doc">
        <DialogHeader>
          <DialogTitle>New document</DialogTitle>
          <DialogDescription>A thread with a body, edited by section.</DialogDescription>
        </DialogHeader>
        <form onSubmit={(event) => (event.preventDefault(), void make())} className="flex flex-col gap-3 text-ui">
          <label>
            Folder
            <input value={channel} onChange={(event) => setChannel(event.target.value)} aria-label="Folder" className="mt-1 w-full rounded-md border border-line-control bg-surface px-2 py-1.5 font-mono" />
          </label>
          <label>
            Title
            <input autoFocus value={title} onChange={(event) => setTitle(event.target.value)} aria-label="Title" className="mt-1 w-full rounded-md border border-line-control bg-surface px-2 py-1.5" />
            {title ? <span className="mt-1 block font-mono text-mono-ui text-muted-foreground">{channel.trim() + '/' + slugOf(title)}</span> : null}
          </label>
          <textarea value={text} onChange={(event) => setText(event.target.value)} onKeyDown={(event) => (event.metaKey || event.ctrlKey) && event.key === 'Enter' && void make()} rows={6} aria-label="First text" placeholder="What it says" className="w-full rounded-md border border-line-control bg-surface p-2" />
          {error ? <p className="text-danger">Not made: {error}</p> : null}
          <div className="flex justify-end">
            <Button variant="primary" type="submit" kbd="⌘↵" disabled={saving || !title.trim()}>
              {saving ? 'Making…' : 'Make the document'}
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  )
}

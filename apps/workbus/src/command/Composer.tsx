// The palette's two writes: a new post, and a new task, each in a channel. Both are the data
// layer's optimistic actions: the dialog closes at once, and a refusal reopens it with the text.
import { useState } from 'react'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { useDocsBus } from '@/docs/bus'

export type ComposerKind = 'post' | 'task'

export function Composer({ kind, onClose, channels, initialChannel }: { kind: ComposerKind | null; onClose: () => void; channels: string[]; initialChannel?: string }) {
  const bus = useDocsBus()
  const [channel, setChannel] = useState(initialChannel ?? 'general')
  const [text, setText] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [failedKind, setFailedKind] = useState<ComposerKind>('post')
  const send = () => {
    if (!text.trim() || !channel.trim()) return
    const tx = kind === 'task' ? bus.actions.createTask({ channel: channel.trim(), text }) : bus.actions.post({ channel: channel.trim(), text })
    const kept = { channel, text, kind: kind ?? 'post' }
    setText('')
    setError(null)
    onClose()
    tx.when('settled').catch((failure: Error) => {
      setChannel(kept.channel)
      setText(kept.text)
      setFailedKind(kept.kind)
      setError(failure.message)
    })
  }
  const open = kind !== null || error !== null
  const shown: ComposerKind = kind ?? failedKind
  return (
    <Dialog open={open} onOpenChange={(next) => !next && (setError(null), onClose())}>
      <DialogContent data-testid="composer">
        <DialogHeader>
          <DialogTitle>{shown === 'task' ? 'Make a task' : 'New post'}</DialogTitle>
          <DialogDescription>{shown === 'task' ? 'A new thread in a channel, ready for someone to take.' : 'A new thread in a channel.'}</DialogDescription>
        </DialogHeader>
        <form onSubmit={(event) => (event.preventDefault(), send())} className="flex flex-col gap-3">
          <label className="text-sm">
            Channel
            <input list="composer-channels" value={channel} onChange={(event) => setChannel(event.target.value)} className="mt-1 w-full rounded-md border bg-background px-2 py-1.5 font-mono text-sm" aria-label="Channel" />
            <datalist id="composer-channels">
              {channels.map((path) => (
                <option key={path} value={path} />
              ))}
            </datalist>
          </label>
          <textarea
            autoFocus
            value={text}
            onChange={(event) => setText(event.target.value)}
            onKeyDown={(event) => (event.metaKey || event.ctrlKey) && event.key === 'Enter' && send()}
            rows={4}
            className="w-full rounded-md border bg-background p-2 text-sm"
            aria-label={shown === 'task' ? 'What needs doing' : 'Message'}
            placeholder={shown === 'task' ? 'What needs doing' : 'Write a message'}
          />
          {error && <p className="text-sm text-destructive">Not sent: {error}</p>}
          <div className="flex justify-end gap-2">
            <Button type="submit" disabled={!text.trim()}>
              {shown === 'task' ? 'Make the task' : 'Post'}
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  )
}

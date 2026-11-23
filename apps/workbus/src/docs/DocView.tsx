// A doc (design/workbus.md §9.3, design/docs.md): its body by section, each section editable on
// its own and commentable, with its comments under it. A section edit shows at once and settles on
// its echo; if someone changed that section first, the board refuses it and the view shows both
// texts, keeping the editor's. History lists the edits, and each shows what it changed.
import { useEffect, useMemo, useState } from 'react'
import { useLiveQuery } from '@tanstack/react-db'
import { History, MessageSquare, Pencil } from 'lucide-react'
import { Button as IconButton } from '@/components/ui/button'
import { Avatar, Button } from '@/components/system'
import { DocConflict } from '@/data/docs-actions'
import type { Message } from '@/data/types'
import { cn } from '@/lib/utils'
import { useDocsBus } from './bus'
import { DocHistory } from './DocHistory'
import { DocPaths, Markdown } from './markdown'
import { parseDoc, type Section } from './sections'

type Editing = { draft: string; revision: string; saving: boolean; conflict: { theirs: string; revision: string; message: string } | null; error: string | null }

/** A doc. In the thread pane (inPane) it's narrower, and the pane's conversation shows the doc-wide comments. */
export function DocView({ id, inPane = false }: { id: string; inPane?: boolean }) {
  const bus = useDocsBus()
  const { data: docs } = useLiveQuery((q) => q.from({ doc: bus.docs }))
  const doc = docs.find((row) => row.id === id)
  const paths = useMemo(() => new Map(docs.map((row) => [row.path, row.id])), [docs])
  const { data: bodies } = useLiveQuery((q) => q.from({ body: bus.bodies }))
  const body = bodies.find((row) => row.id === id)
  const { data: replies } = useLiveQuery((q) => q.from({ message: bus.messages }))
  const comments = useMemo(() => replies.filter((message) => message.re === id && !message.deleted).sort((a, b) => a.createdAt.localeCompare(b.createdAt)), [replies, id])
  const [failed, setFailed] = useState<string | null>(null)
  const [showHistory, setShowHistory] = useState(false)

  useEffect(() => {
    setFailed(null)
    Promise.all([bus.openDoc(id), bus.openThread(id)]).catch((error: Error) => setFailed(error.message))
    return () => void (inPane || bus.closeThread(id))
  }, [bus, id, inPane])

  // Bring the section a link names into view once the body is there: by its key, or a key ending in it.
  useEffect(() => {
    if (!body || !location.hash) return
    const want = decodeURIComponent(location.hash.slice(1))
    const key = parseDoc(body.body).find((section) => section.key === want || section.key.endsWith('/' + want))?.key
    if (key !== undefined) document.getElementById(anchor(key))?.scrollIntoView({ block: 'start' })
  }, [body?.id, Boolean(body)])

  if (failed) return <p className="p-8 text-danger">This doc didn't load: {failed}</p>
  if (!doc || !body) return <p className="p-8 text-muted-foreground">Loading…</p>

  const sections = parseDoc(body.body)
  const keys = new Set(sections.map((section) => section.key))
  const bySection = new Map<string, Message[]>()
  const general: Message[] = []
  const detached: Message[] = []
  for (const comment of comments) {
    const key = comment.labels['board.doc.section']
    if (key === undefined) general.push(comment)
    else if (keys.has(key)) bySection.set(key, [...(bySection.get(key) ?? []), comment])
    else detached.push(comment)
  }

  return (
    <DocPaths.Provider value={paths}>
      <article className={inPane ? 'px-4 py-4' : 'mx-auto max-w-3xl px-8 py-10'} data-testid="doc" data-revision={body.revision}>
        <header className="mb-6 flex items-start justify-between gap-4">
          <div>
            <p className="font-mono text-mono-ui tracking-wider text-muted-foreground uppercase">Document · revision {body.revision}</p>
            <p className="mt-1 font-mono text-mono-ui text-muted-foreground" data-testid="doc-path">
              {doc.path}{inPane ? '' : ' · ' + comments.length + (comments.length === 1 ? ' comment' : ' comments')}
            </p>
          </div>
          <Button variant="outline" size="sm" icon={History} onClick={() => setShowHistory((on) => !on)}>
            {showHistory ? 'Hide history' : 'History'}
          </Button>
        </header>
        {showHistory && <DocHistory id={id} />}
        <div className="doc-body text-doc">
          {sections.map((section) => (
            <DocSection key={section.key} docId={id} section={section} revision={body.revision} comments={bySection.get(section.key) ?? []} />
          ))}
        </div>
        {!inPane && <Comments docId={id} title="Comments on the doc" comments={general} />}
        {detached.length > 0 && <Comments docId={id} title="On sections that are gone" comments={detached} readOnly />}
      </article>
    </DocPaths.Provider>
  )
}

const anchor = (key: string) => (key === '' ? 'top' : key)

function DocSection({ docId, section, revision, comments }: { docId: string; section: Section; revision: string; comments: Message[] }) {
  const bus = useDocsBus()
  const [editing, setEditing] = useState<Editing | null>(null)
  const [commenting, setCommenting] = useState(false)
  const start = () => setEditing({ draft: section.own.replace(/^\n+/, '').replace(/\n+$/, ''), revision, saving: false, conflict: null, error: null })

  const save = (draft: string, at: string) => {
    if (/^ {0,3}#{1,6}(?:[ \t]|$)/m.test(draft)) {
      setEditing((had) => had && { ...had, error: "A section's text holds no headings: add a section after this one for that." })
      return
    }
    setEditing((had) => had && { ...had, draft, saving: true, error: null })
    const tx = bus.docActions.editSection({ id: docId, section: section.key, text: draft, revision: at })
    tx.when('settled').then(
      () => setEditing(null),
      (error: Error) => {
        if (error instanceof DocConflict) {
          const theirs = parseDoc(bus.bodies.utils.rows.get(docId)?.body ?? '').find((s) => s.key === section.key)?.own ?? ''
          setEditing((had) => had && { ...had, saving: false, conflict: { theirs: theirs.trim(), revision: error.revision, message: error.message } })
        } else setEditing((had) => had && { ...had, saving: false, error: error.message })
      },
    )
  }

  return (
    <section id={anchor(section.key)} data-section={section.key} className="group relative scroll-mt-6">
      {section.key !== '' && (
        <div className="relative">
          <Markdown>{section.head}</Markdown>
          <SectionTools onEdit={editing ? undefined : start} onComment={() => setCommenting((on) => !on)} comments={comments.length} label={section.title} />
        </div>
      )}
      {editing && !editing.saving ? (
        <SectionEditor editing={editing} setDraft={(draft) => setEditing((had) => had && { ...had, draft })} onSave={() => save(editing.draft, editing.conflict ? editing.conflict.revision : editing.revision)} onCancel={() => setEditing(null)} onTakeTheirs={() => setEditing(null)} />
      ) : (
        <div className={cn(section.key === '' && 'relative', editing?.saving && 'opacity-70')} data-saving={editing?.saving ? 'yes' : undefined}>
          {section.key === '' && section.own.trim() !== '' && <SectionTools onEdit={editing ? undefined : start} onComment={() => setCommenting((on) => !on)} comments={comments.length} label="the introduction" />}
          <Markdown>{section.own}</Markdown>
        </div>
      )}
      {(comments.length > 0 || commenting) && (
        <aside className="mb-4 ml-2 border-l-2 pl-4" data-testid="section-comments">
          {comments.map((comment) => (
            <Comment key={comment.id} comment={comment} />
          ))}
          {commenting && <CommentBox docId={docId} section={section.key} onDone={() => setCommenting(false)} />}
        </aside>
      )}
    </section>
  )
}

function SectionTools({ onEdit, onComment, comments, label }: { onEdit?: () => void; onComment: () => void; comments: number; label: string }) {
  return (
    <div className="absolute top-0 right-0 flex gap-1 rounded-md bg-background/90 opacity-0 transition-opacity group-hover:opacity-100 focus-within:opacity-100">
      {onEdit && (
        <IconButton variant="ghost" size="icon" className="size-7" onClick={onEdit} aria-label={'Edit ' + label} title="Edit this section">
          <Pencil />
        </IconButton>
      )}
      <IconButton variant="ghost" size="icon" className="size-7" onClick={onComment} aria-label={'Comment on ' + label} title="Comment on this section">
        <MessageSquare />
        {comments > 0 && <span className="sr-only">{comments}</span>}
      </IconButton>
    </div>
  )
}

function SectionEditor({ editing, setDraft, onSave, onCancel, onTakeTheirs }: { editing: Editing; setDraft: (draft: string) => void; onSave: () => void; onCancel: () => void; onTakeTheirs: () => void }) {
  return (
    <div className="my-3 rounded-md border p-3" data-testid="section-editor">
      {editing.conflict && (
        <div className="mb-3 rounded-md border border-held bg-held-soft p-3 text-ui" role="alert" data-testid="section-conflict">
          <p className="font-medium">Someone changed this section after you opened it (now revision {editing.conflict.revision}). Your text is below, unchanged.</p>
          <p className="mt-2 text-small text-muted-foreground">What it says now:</p>
          <div className="mt-1 rounded border border-line-control bg-surface px-3 py-1" data-testid="section-theirs">
            <Markdown>{editing.conflict.theirs || '*(empty)*'}</Markdown>
          </div>
        </div>
      )}
      <textarea
        autoFocus
        value={editing.draft}
        onChange={(event) => setDraft(event.target.value)}
        onKeyDown={(event) => {
          if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') onSave()
          if (event.key === 'Escape') onCancel()
        }}
        rows={Math.min(24, Math.max(4, editing.draft.split('\n').length + 1))}
        className="w-full resize-y rounded-md border border-line-control bg-surface p-2 font-mono text-ui"
        aria-label="Section text"
        disabled={editing.saving}
      />
      {editing.error && <p className="mt-2 text-ui text-danger">{editing.error}</p>}
      <div className="mt-2 flex items-center gap-2">
        <Button variant="primary" size="sm" kbd="⌘↵" onClick={onSave} disabled={editing.saving}>
          {editing.saving ? 'Saving…' : editing.conflict ? 'Save mine over it' : 'Save'}
        </Button>
        {editing.conflict && (
          <Button size="sm" variant="outline" onClick={onTakeTheirs}>
            Keep theirs, drop mine
          </Button>
        )}
        <Button size="sm" variant="ghost" kbd="esc" onClick={onCancel} disabled={editing.saving}>
          Cancel
        </Button>
      </div>
    </div>
  )
}

function Comments({ docId, title, comments, readOnly = false }: { docId: string; title: string; comments: Message[]; readOnly?: boolean }) {
  return (
    <section className="mt-10 border-t pt-6" data-testid={readOnly ? 'detached-comments' : 'doc-comments'}>
      <h2 className="mb-3 text-ui font-semibold">{title}</h2>
      {comments.map((comment) => (
        <Comment key={comment.id} comment={comment} detached={readOnly} />
      ))}
      {!readOnly && <CommentBox docId={docId} />}
    </section>
  )
}

function Comment({ comment, detached = false }: { comment: Message; detached?: boolean }) {
  const bus = useDocsBus()
  const author = bus.actors.get(comment.by.actor)
  return (
    <div className={cn('mb-3 text-ui', comment.pending && 'opacity-60')} data-testid="comment" data-pending={comment.pending ? 'yes' : undefined}>
      <p className="flex items-center gap-2 text-small text-muted-foreground">
        <Avatar size="xs" kind={author && author.kind !== 'person' ? 'agent' : 'person'} initials={(author?.name ?? comment.by.actor.replace(/^.*:/, '')).slice(0, 2).toUpperCase()} />
        <span className="font-medium text-foreground">{author?.name ?? comment.by.actor}</span>
        <span className="font-mono">@{author?.handle ?? comment.by.actor.replace(/^.*:/, '')}</span>
        <span className="ml-auto font-mono">{comment.pending ? 'sending…' : new Date(comment.createdAt).toLocaleTimeString([], { hour12: false }) + ' · #' + comment.id}</span>
        {detached && <> · on “{comment.labels['board.doc.section']}”</>}
      </p>
      <Markdown>{comment.text}</Markdown>
    </div>
  )
}

function CommentBox({ docId, section, onDone }: { docId: string; section?: string; onDone?: () => void }) {
  const bus = useDocsBus()
  const [text, setText] = useState('')
  const [error, setError] = useState<string | null>(null)
  const send = () => {
    if (!text.trim()) return
    const tx = bus.docActions.comment({ doc: docId, text, ...(section !== undefined ? { section } : {}) })
    setText('')
    setError(null)
    onDone?.()
    tx.when('settled').catch((failure: Error) => (setText(text), setError(failure.message)))
  }
  return (
    <form onSubmit={(event) => (event.preventDefault(), send())} className="mt-2 flex flex-col gap-2">
      <textarea
        value={text}
        onChange={(event) => setText(event.target.value)}
        onKeyDown={(event) => (event.metaKey || event.ctrlKey) && event.key === 'Enter' && send()}
        rows={2}
        placeholder={section !== undefined ? 'Comment on this section' : 'Comment on the doc'}
        className="w-full rounded-md border border-line-control bg-surface p-2 text-ui"
        aria-label={section !== undefined ? 'Comment on this section' : 'Comment on the doc'}
      />
      {error && <p className="text-ui text-danger">Not sent: {error}</p>}
      <div>
        <Button size="sm" type="submit" kbd="⌘↵" disabled={!text.trim()}>
          Comment
        </Button>
      </div>
    </form>
  )
}


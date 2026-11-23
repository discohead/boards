// The top bar: where you are (the org, then the view), and the live log's cursor.
import { Box } from 'lucide-react'
import { useLiveCursor } from './live-cursor.ts'

export function TopBar({ title }: { title: string }) {
  const cursor = useLiveCursor()
  return (
    <header className="flex h-11 shrink-0 items-center justify-between border-b px-4 text-sm">
      <div className="flex items-center gap-2 text-muted-foreground">
        <Box size={16} strokeWidth={1.5} aria-hidden />
        <span>Workbus</span>
        <span aria-hidden>/</span>
        <strong data-testid="view-title" className="font-medium text-foreground">
          {title}
        </strong>
      </div>
      <span data-testid="live-cursor" className="flex items-center gap-2 font-mono text-xs text-muted-foreground">
        <i aria-hidden className={'size-1.5 rounded-full ' + (cursor === null ? 'bg-muted-foreground' : 'bg-agent')} />
        Live log <span aria-hidden>/</span> {cursor === null ? '…' : '#' + cursor}
      </span>
    </header>
  )
}

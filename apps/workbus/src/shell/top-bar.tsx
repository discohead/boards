// The top bar: where you are (the org, then the view), and the live log's cursor.
import { Boxes } from 'lucide-react'
import { useLiveCursor } from './live-cursor.ts'

export function TopBar({ title }: { title: string }) {
  const cursor = useLiveCursor()
  return (
    <header className="flex h-[47px] flex-none items-center justify-between gap-2 border-b border-line px-[18px]">
      <div className="flex items-center gap-2 text-[12px] text-muted-foreground">
        <Boxes size={14} strokeWidth={1.5} aria-hidden />
        <span>Workbus</span>
        <span aria-hidden className="text-line-control">/</span>
        <strong data-testid="view-title" className="font-[550] text-text">
          {title}
        </strong>
      </div>
      <span data-testid="live-cursor" className="flex items-center gap-[7px] font-mono text-mono-ui text-muted-foreground tabular-nums">
        <i aria-hidden className={'size-1.5 rounded-full ' + (cursor === null ? 'bg-muted-foreground' : 'bg-agent')} />
        Live log <span aria-hidden>/</span> {cursor === null ? '…' : '#' + cursor}
      </span>
    </header>
  )
}

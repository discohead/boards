export interface NewEventsPillProps {
  count: number
  direction?: 'up' | 'down'
  onClick?: () => void
}

/** Events that arrived while you were scrolled away: "3 new ↓". The only round thing but people. */
export function NewEventsPill({ count, direction = 'down', onClick }: NewEventsPillProps) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="inline-flex cursor-pointer items-center gap-1.5 rounded-full bg-text px-2.5 py-[3px] text-[12px] font-semibold text-bg shadow-float"
    >
      {count} new {direction === 'up' ? '↑' : '↓'}
    </button>
  )
}

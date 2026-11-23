// Icons are Lucide (lucide-react, the set shadcn/ui ships) at 16px with a 1.5 stroke, in the
// current text color. IconName is the system's own short list; any Lucide icon also works.
import type { LucideIcon, LucideProps } from 'lucide-react'
import { Check, FileText, MessageSquare, Pause, Plus, Search, SquareCheck, Trash2, User, X } from 'lucide-react'

export type IconName = 'search' | 'check' | 'x' | 'trash' | 'pause' | 'user' | 'task' | 'doc' | 'message' | 'plus'

const ICONS: Record<IconName, LucideIcon> = {
  search: Search,
  check: Check,
  x: X,
  trash: Trash2,
  pause: Pause,
  user: User,
  task: SquareCheck,
  doc: FileText,
  message: MessageSquare,
  plus: Plus,
}

export type IconProp = IconName | LucideIcon

export function Icon({ name, size = 16, strokeWidth = 1.5, ...props }: { name: IconProp } & Omit<LucideProps, 'name'>) {
  const Glyph = typeof name === 'string' ? ICONS[name] : name
  return <Glyph size={size} strokeWidth={strokeWidth} aria-hidden {...props} />
}

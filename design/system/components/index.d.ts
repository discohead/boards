// Workbus components: window.Workbus. React 18 on the page; tokens.css and bundle.css loaded.
import type { ReactNode } from 'react'

export type SeatStateName = 'active' | 'working' | 'waiting' | 'paused' | 'over_budget'
export type KindName = 'approval' | 'decision' | 'budget' | 'review' | 'proposal' | 'mention' | 'done' | 'failed'
export type TaskStateName = 'ready' | 'claimed' | 'held' | 'done' | 'failed'
export type IconName = 'search' | 'check' | 'x' | 'trash' | 'pause' | 'user' | 'task' | 'doc' | 'message' | 'plus'

export interface ButtonProps {
  /** primary: the one main action in a view (vermilion). danger: destructive, crimson outline. */
  variant?: 'primary' | 'secondary' | 'outline' | 'ghost' | 'danger'
  size?: 'sm' | 'md' | 'lg'
  /** Keyboard shortcut shown inside the button, e.g. "⌘↵". */
  kbd?: string
  icon?: IconName
  disabled?: boolean
  type?: 'button' | 'submit'
  title?: string
  onClick?: () => void
  children: ReactNode
}
export interface KbdProps { children: ReactNode }
export interface InputProps {
  id?: string
  label?: string
  /** Mono affix before the value: "$", "@". */
  prefix?: string
  placeholder?: string
  value?: string
  defaultValue?: string
  kbd?: string
  hint?: string
  /** Says what's wrong and how to fix it. */
  error?: string
  onChange?: (e: unknown) => void
}
export interface AvatarProps {
  /** person: round and ink. agent: square, in the agent color. */
  kind?: 'person' | 'agent'
  initials: string
  name?: string
  size?: 'xs' | 'sm' | 'md' | 'lg'
}
export interface SeatStateProps { state: SeatStateName; label?: string }
export interface KindProps { kind: KindName; children?: ReactNode }
export interface LabelProps { name: string; value?: string }
export interface HeldPillProps { kind?: 'approval' | 'decision' | 'review' | 'budget' }
export interface TaskStateProps { state: TaskStateName }
export interface TabsProps {
  tabs: { id: string; label: string; count?: number; add?: boolean; onAdd?: () => void }[]
  value?: string
  onChange?: (id: string) => void
}
export interface SidebarItemProps {
  children: ReactNode
  active?: boolean
  unread?: boolean
  child?: boolean
  count?: number
  state?: SeatStateName
  meta?: string | number
  avatar?: AvatarProps
}
export interface MenuItem { label: string; icon?: IconName; kbd?: string; danger?: boolean; active?: boolean; onSelect?: () => void }
export interface MenuProps { items: (MenuItem | '-')[] }
export interface CommandPaletteProps {
  query?: string
  groups: { name: string; items: { label: string; path?: string; kbd?: string; active?: boolean; icon?: IconName; task?: TaskStateName; state?: SeatStateName; avatar?: AvatarProps }[] }[]
}
export interface ToastProps {
  children: ReactNode
  tone?: 'success' | 'danger'
  /** The log position the action produced, e.g. "#1288". */
  cursor?: string
  action?: { label: string; kbd?: string; onClick?: () => void }
}
export interface NewEventsPillProps { count: number; direction?: 'up' | 'down'; onClick?: () => void }
export interface IssueRowProps {
  cursor: string
  state: TaskStateName
  title: string
  kinds?: KindName[]
  labels?: [string, string][]
  assignee?: AvatarProps
  updated: string
  selected?: boolean
}
export interface BoardCardProps {
  cursor: string
  channel?: string
  state: TaskStateName
  title: string
  kinds?: KindName[]
  labels?: [string, string][]
  assignee?: AvatarProps
  cost?: string
}
export interface MessageProps {
  author: { name: string; handle?: string; initials: string; kind?: 'person' | 'agent' }
  time?: string
  cursor?: string
  /** Your own write before its event comes back. */
  pending?: boolean
  /** A new event from someone else: a brief agent tint. */
  arrive?: boolean
  children: ReactNode
}
export interface ToolCallProps { name: string; input: unknown; status?: 'held' | 'running' | 'ok' | 'failed'; statusLabel?: string }
export interface ApprovalCardProps {
  title: string
  reason?: string
  approveLabel?: string
  /** Run facts: "18 steps · 41s · $0.42". */
  run?: string
  onApprove?: () => void
  onDecline?: () => void
  onReply?: () => void
}

// The Workbus design system's components (design/system/), on shadcn/ui and Tailwind. The props
// are the system's index.d.ts, plus a className and a few marked additions.
export { Icon, type IconName, type IconProp } from './icon'
export { Kbd, type KbdProps } from './kbd'
export { Button, type ButtonProps } from './button'
export { Input, type InputProps } from './input'
export { Avatar, type AvatarProps } from './avatar'
export {
  SeatState,
  Kind,
  Label,
  HeldPill,
  TaskState,
  type SeatStateName,
  type KindName,
  type TaskStateName,
  type SeatStateProps,
  type KindProps,
  type LabelProps,
  type HeldPillProps,
  type TaskStateProps,
} from './status'
export { Tabs, type TabsProps } from './tabs'
export { SidebarItem, SidebarGroup, type SidebarItemProps } from './sidebar-item'
export { Menu, type MenuItem, type MenuProps } from './menu'
export { CommandPalette, type CommandPaletteItem, type CommandPaletteProps } from './command-palette'
export { Toast, toast, type ToastProps } from './toast'
export { NewEventsPill, type NewEventsPillProps } from './new-events-pill'
export { IssueRow, BoardCard, type IssueRowProps, type BoardCardProps } from './lists'
export { Message, ToolCall, ApprovalCard, type MessageProps, type ToolCallProps, type ApprovalCardProps } from './conversation'
export { Lockup, Mark } from './logo'
export { useTheme, useDensity, type ThemeSetting, type Density } from './appearance'

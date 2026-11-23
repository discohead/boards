// The keyboard's cheat sheet: every shortcut mounted now, by group, read from TanStack Hotkeys'
// registrations, so it never drifts from what the keys do. ? opens it.
import { useHotkey, useHotkeyRegistrations, useFormatForDisplay } from '@tanstack/react-hotkeys'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog'

export function CheatSheet({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  useHotkey('Shift+/', () => onOpenChange(!open), { meta: { name: 'Keyboard shortcuts', group: 'Everywhere' } })
  const registrations = useHotkeyRegistrations()
  const format = useFormatForDisplay()
  const groups = new Map<string, { key: string; name: string }[]>()
  for (const registration of registrations) {
    const meta = registration.options.meta
    if (!meta?.name) continue
    const key = typeof registration.hotkey === 'string' ? format(registration.hotkey) : registration.hotkey.map((step) => format(step)).join(' ')
    const group = meta.group ?? 'Other'
    if (!groups.get(group)?.some((entry) => entry.key === key)) groups.set(group, [...(groups.get(group) ?? []), { key, name: meta.name }])
  }
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent data-testid="cheat-sheet">
        <DialogHeader>
          <DialogTitle>Keyboard shortcuts</DialogTitle>
          <DialogDescription>Single keys don't fire while you're typing.</DialogDescription>
        </DialogHeader>
        {[...groups].map(([group, entries]) => (
          <section key={group}>
            <h3 className="mb-1 text-xs font-medium text-muted-foreground">{group}</h3>
            <ul className="space-y-1 text-sm">
              {entries.map((entry) => (
                <li key={entry.key} className="flex items-center justify-between">
                  {entry.name}
                  <kbd className="rounded border bg-muted px-1.5 py-0.5 font-mono text-xs">{entry.key}</kbd>
                </li>
              ))}
            </ul>
          </section>
        ))}
      </DialogContent>
    </Dialog>
  )
}

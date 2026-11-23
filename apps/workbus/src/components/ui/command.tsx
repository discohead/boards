import * as React from 'react'
import { Command as CommandPrimitive } from 'cmdk'
import { Search } from 'lucide-react'
import { cn } from '@/lib/utils'
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@/components/ui/dialog'

// shadcn/ui's Command (cmdk), restyled as the system's ⌘K: a 15px query, mono group names, 32px
// rows, and the active row on raised with a 2px held inset bar.
function Command({ className, ...props }: React.ComponentProps<typeof CommandPrimitive>) {
  return (
    <CommandPrimitive
      data-slot="command"
      className={cn('flex h-full w-full flex-col overflow-hidden rounded-md bg-surface text-text', className)}
      {...props}
    />
  )
}

function CommandDialog({
  title = 'Command menu',
  description = 'Run a command, search, or ask @op',
  children,
  className,
  shouldFilter,
  ...props
}: React.ComponentProps<typeof Dialog> & { title?: string; description?: string; className?: string; shouldFilter?: boolean }) {
  return (
    <Dialog {...props}>
      <DialogContent className={cn('max-w-[560px] overflow-hidden p-0 sm:max-w-[560px]', className)}>
        <DialogTitle className="sr-only">{title}</DialogTitle>
        <DialogDescription className="sr-only">{description}</DialogDescription>
        <Command loop shouldFilter={shouldFilter}>
          {children}
        </Command>
      </DialogContent>
    </Dialog>
  )
}

function CommandInput({ className, ...props }: React.ComponentProps<typeof CommandPrimitive.Input>) {
  return (
    <div data-slot="command-input-wrapper" className="flex items-center gap-2.5 border-b border-line px-3.5 py-3">
      <Search className="size-4 shrink-0 text-muted-foreground" strokeWidth={1.75} aria-hidden />
      <CommandPrimitive.Input
        data-slot="command-input"
        className={cn('flex-1 bg-transparent text-[15px] text-text caret-held outline-none placeholder:text-muted-foreground focus-visible:outline-none', className)}
        {...props}
      />
    </div>
  )
}

function CommandList({ className, ...props }: React.ComponentProps<typeof CommandPrimitive.List>) {
  return <CommandPrimitive.List data-slot="command-list" className={cn('max-h-[360px] scroll-py-1 overflow-x-hidden overflow-y-auto', className)} {...props} />
}

function CommandEmpty(props: React.ComponentProps<typeof CommandPrimitive.Empty>) {
  return <CommandPrimitive.Empty data-slot="command-empty" className="px-3.5 py-6 text-center text-muted-foreground" {...props} />
}

function CommandGroup({ className, ...props }: React.ComponentProps<typeof CommandPrimitive.Group>) {
  return (
    <CommandPrimitive.Group
      data-slot="command-group"
      className={cn(
        'overflow-hidden text-text [&_[cmdk-group-heading]]:px-3.5 [&_[cmdk-group-heading]]:pt-2.5 [&_[cmdk-group-heading]]:pb-1 [&_[cmdk-group-heading]]:font-mono [&_[cmdk-group-heading]]:text-mono-label [&_[cmdk-group-heading]]:font-normal [&_[cmdk-group-heading]]:text-muted-foreground',
        className,
      )}
      {...props}
    />
  )
}

function CommandSeparator({ className, ...props }: React.ComponentProps<typeof CommandPrimitive.Separator>) {
  return <CommandPrimitive.Separator data-slot="command-separator" className={cn('h-px bg-line', className)} {...props} />
}

function CommandItem({ className, ...props }: React.ComponentProps<typeof CommandPrimitive.Item>) {
  return (
    <CommandPrimitive.Item
      data-slot="command-item"
      className={cn(
        "relative flex h-8 cursor-pointer items-center gap-2.5 px-3.5 text-[13px] text-text outline-none select-none data-[disabled=true]:pointer-events-none data-[disabled=true]:opacity-45 data-[selected=true]:bg-raised data-[selected=true]:shadow-[inset_2px_0_0_var(--wb-held)] [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='text-'])]:text-muted-foreground [&_svg:not([class*='size-'])]:size-3.5",
        className,
      )}
      {...props}
    />
  )
}

function CommandShortcut({ className, ...props }: React.ComponentProps<'span'>) {
  return <span data-slot="command-shortcut" className={cn('ml-auto font-mono text-mono-label text-muted-foreground', className)} {...props} />
}

function CommandFooter({ className, ...props }: React.ComponentProps<'div'>) {
  return (
    <div
      data-slot="command-footer"
      className={cn('flex gap-4 border-t border-line bg-sidebar px-3.5 py-2 font-mono text-mono-label font-normal text-muted-foreground', className)}
      {...props}
    />
  )
}

export { Command, CommandDialog, CommandInput, CommandList, CommandEmpty, CommandGroup, CommandItem, CommandShortcut, CommandSeparator, CommandFooter }

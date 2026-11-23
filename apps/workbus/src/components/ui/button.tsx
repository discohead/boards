import * as React from 'react'
import { cva, type VariantProps } from 'class-variance-authority'
import { Slot } from 'radix-ui'
import { cn } from '@/lib/utils'

// shadcn/ui's Button, restyled by the Workbus design system: 28px, 4px corners, 600 labels.
// default (primary) is vermilion and goes on the one main action in a view; destructive is a
// crimson outline, never a fill, so it can't read as primary.
const buttonVariants = cva(
  "inline-flex shrink-0 cursor-pointer items-center justify-center gap-2 rounded-sm border border-transparent text-[13px] font-semibold whitespace-nowrap transition-fast disabled:cursor-not-allowed disabled:opacity-45 disabled:filter-none aria-invalid:border-danger [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-3.5",
  {
    variants: {
      variant: {
        default: 'border-brand bg-brand text-on-brand hover:brightness-94',
        secondary: 'border-line bg-raised text-text hover:border-line-strong',
        outline: 'border-line-strong bg-surface text-text hover:bg-raised',
        ghost: 'text-muted-foreground hover:bg-raised hover:text-text',
        destructive: 'border-danger bg-surface text-danger',
        link: 'text-info underline-offset-4 hover:underline',
      },
      size: {
        default: 'h-control-md px-2.5',
        xs: 'h-5 gap-1 px-1.5 text-[11px]',
        sm: 'h-control-sm px-2 text-[12px]',
        lg: 'h-control-lg px-4 text-[13.5px]',
        icon: 'size-control-md',
        'icon-xs': 'size-5',
        'icon-sm': 'size-control-sm',
        'icon-lg': 'size-control-lg',
      },
    },
    defaultVariants: { variant: 'default', size: 'default' },
  },
)

function Button({
  className,
  variant = 'default',
  size = 'default',
  asChild = false,
  ...props
}: React.ComponentProps<'button'> & VariantProps<typeof buttonVariants> & { asChild?: boolean }) {
  const Comp = asChild ? Slot.Root : 'button'
  return (
    <Comp
      data-slot="button"
      data-variant={variant}
      data-size={size}
      className={cn(buttonVariants({ variant, size, className }))}
      {...props}
    />
  )
}

export { Button, buttonVariants }

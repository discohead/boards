import { clsx, type ClassValue } from 'clsx'
import { extendTailwindMerge } from 'tailwind-merge'

// tailwind-merge has to know the design system's names (styles.css), or it reads text-mono-label
// as a color and drops it beside text-muted-foreground.
const twMerge = extendTailwindMerge({
  extend: {
    theme: {
      text: ['title-xl', 'title-lg', 'title-md', 'doc', 'ui', 'small', 'mono-ui', 'mono-label', 'code'],
      spacing: ['row', 'row-compact', 'row-comfortable', 'control-sm', 'control-md', 'control-lg', 'avatar-xs', 'avatar-sm', 'avatar-md', 'avatar-lg', 'icon', 'sidebar', 'list'],
      shadow: ['float'],
    },
  },
})

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs))
}

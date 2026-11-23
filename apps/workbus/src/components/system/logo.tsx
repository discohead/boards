// The Route mark: two past stops and a vermilion stop for now. The files have fixed inks, so each
// draws both and shows the one for the nearest theme (.wb-on-light / .wb-on-dark in styles.css).
import { cn } from '@/lib/utils'
import lockup from '@/assets/logos/workbus-lockup.svg?url'
import lockupDark from '@/assets/logos/workbus-lockup-dark.svg?url'
import mark from '@/assets/logos/workbus-mark.svg?url'
import markDark from '@/assets/logos/workbus-mark-dark.svg?url'

/** Mark and wordmark, for the app header. At least 20px tall. */
export function Lockup({ height = 20, className }: { height?: number; className?: string }) {
  const width = Math.round((height * 198.39) / 32)
  return (
    <span role="img" aria-label="Workbus" className={cn('inline-flex', className)}>
      <img src={lockup} alt="" width={width} height={height} className="wb-on-light" />
      <img src={lockupDark} alt="" width={width} height={height} className="wb-on-dark" />
    </span>
  )
}

/** The mark alone, where the name is already present. At least 16px wide. */
export function Mark({ size = 16, className }: { size?: number; className?: string }) {
  return (
    <span role="img" aria-label="Workbus" className={cn('inline-flex', className)}>
      <img src={mark} alt="" width={size} height={size} className="wb-on-light" />
      <img src={markDark} alt="" width={size} height={size} className="wb-on-dark" />
    </span>
  )
}

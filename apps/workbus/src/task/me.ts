// Who the page is, with what it may do (GET /me's can, in runtime.me once /me answers): which
// channels I manage, for a task's owner writes, and which I may edit, for proposals.
import { useEffect, useState } from 'react'
import { useBus } from '@/data'
import type { Me } from '@/data/runtime'

export function useMe(): Me | null {
  const bus = useBus()
  const [me, setMe] = useState<Me | null>(bus.runtime.me.actor ? bus.runtime.me : null)
  useEffect(() => {
    if (bus.runtime.mode !== 'browser') return
    let live = true
    void Promise.resolve(bus.runtime.shared.get('me')).then(() => live && bus.runtime.me.actor && setMe({ ...bus.runtime.me }))
    return () => void (live = false)
  }, [bus])
  return me
}

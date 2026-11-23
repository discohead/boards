// The feed's cursor, live, for the top bar. Null until the page has hydrated and the feed has
// started, on the server and the client alike, so the first render matches.
import { useEffect, useState } from 'react'
import { useBus } from '@/data'

export function useLiveCursor(): number | null {
  const bus = useBus()
  const [cursor, setCursor] = useState<number | null>(null)
  useEffect(() => {
    const feed = bus.runtime.feed
    if (!feed) return
    setCursor(feed.cursor)
    const watch = (next: number) => setCursor(next)
    feed.watchers.add(watch)
    return () => void feed.watchers.delete(watch)
  }, [bus])
  return cursor
}

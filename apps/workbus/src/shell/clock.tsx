// A log time in the reader's own time zone. The server doesn't know it, so the server's render (and
// the hydrating one) show UTC, marked as such, and the browser switches to local time right after.
import { useEffect, useState } from 'react'

const format = (date: Date, seconds: boolean, timeZone?: string) => date.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', ...(seconds ? { second: '2-digit' } : {}), hour12: false, ...(timeZone ? { timeZone } : {}) })

/** The clock text for a time, for components that take a string: UTC until hydrated, then local. */
export function useClockText(at: string, seconds = false): string {
  const [local, setLocal] = useState(false)
  useEffect(() => setLocal(true), [])
  const date = new Date(at)
  return local ? format(date, seconds) : format(date, seconds, 'UTC')
}

export function Clock({ at, seconds = false }: { at: string; seconds?: boolean }) {
  const text = useClockText(at, seconds)
  return (
    <time dateTime={at} title={new Date(at).toISOString()}>
      {text}
    </time>
  )
}

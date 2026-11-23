// A log time in the reader's own time zone. The server doesn't know it, so the server's render (and
// the hydrating one) show UTC, marked as such, and the browser switches to local time right after.
import { useEffect, useState } from 'react'

const format = (date: Date, seconds: boolean, timeZone?: string) => date.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', ...(seconds ? { second: '2-digit' } : {}), hour12: false, ...(timeZone ? { timeZone } : {}) })

export function Clock({ at, seconds = false }: { at: string; seconds?: boolean }) {
  const date = new Date(at)
  const [local, setLocal] = useState(false)
  useEffect(() => setLocal(true), [])
  return (
    <time dateTime={at} title={date.toISOString()}>
      {local ? format(date, seconds) : format(date, seconds, 'UTC')}
    </time>
  )
}

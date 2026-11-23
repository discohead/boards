/** "3m", "2h", "5d", or a date: how long ago, as a list says it. */
export function ago(iso: string | null | undefined, now = Date.now()) {
  if (!iso) return ''
  const s = Math.max(0, (now - Date.parse(iso)) / 1000)
  if (s < 60) return 'now'
  if (s < 3600) return Math.floor(s / 60) + 'm'
  if (s < 86400) return Math.floor(s / 3600) + 'h'
  if (s < 86400 * 30) return Math.floor(s / 86400) + 'd'
  return new Date(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
}
